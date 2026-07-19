const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const { IS_WIN, exec, shQuote, toShellPath } = require('./platform');
const path = require('path');
const config = require('./config');

/* Installs Claude Code skills from a GitHub repo as a local git clone, and —
 * when enabled — symlinks them into ~/.claude/skills/<id>/ so every agent
 * auto-discovers them via Claude Code's own skill resolution (/skill-name,
 * or the model's own judgment) instead of SwarmEye reinventing prompt
 * injection. Disabled skills just sit in the clone folder; the Skills screen
 * offers a copy-paste command to symlink one into a single project's
 * .claude/skills/ instead.
 *
 * git/find/ln all run in the shell, so every host path handed to one goes
 * through toShellPath first (a no-op on macOS, C:\ -> /mnt/c on Windows).
 *
 * A repo can itself be a single skill (SKILL.md at its root) or a pack of
 * several (SKILL.md nested under skills/<name>/, plugins/<name>/, etc. — the
 * shape real-world "skill" repos actually ship, confirmed against
 * github.com/juliusbrussee/caveman, which has no root SKILL.md at all).
 * install() discovers every SKILL.md up to 4 levels deep and registers one
 * toggleable entry per skill found, all sharing one clone (grouped by
 * repoId) so a multi-skill repo isn't cloned once per skill and isn't left
 * on disk until every one of its skills has been removed. */

/* Quote a host path for a shell command, or null when it can't be reached
 * from the shell at all (Windows paths that aren't drive-letter paths). */
function pathQ(p) {
  const sp = toShellPath(p);
  return sp === null ? null : shQuote(sp);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function parseRepoUrl(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/.exec(String(url || '').trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/* SKILL.md's YAML frontmatter (---\n name: ...\n description: ...\n ---) —
 * covers both an inline value and a block scalar (`description: >` or `|`,
 * with the text on indented continuation lines — what most real skills use
 * for anything longer than a sentence). No real yaml parser for two fields. */
function readSkillMeta(dest, fallbackName) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'); } catch { /* no SKILL.md */ }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  let name = fallbackName;
  let description = '';
  if (fm) {
    const lines = fm[1].split(/\r?\n/);
    const nameLine = lines.find((l) => /^name:/.test(l));
    if (nameLine) name = nameLine.replace(/^name:\s*/, '').trim().replace(/^["']|["']$/g, '') || name;

    const descIdx = lines.findIndex((l) => /^description:/.test(l));
    if (descIdx !== -1) {
      const inline = lines[descIdx].replace(/^description:\s*/, '').trim();
      if (inline && !/^[|>]/.test(inline)) {
        description = inline.replace(/^["']|["']$/g, '');
      } else {
        // block scalar (| or >, with optional chomping like |- or >+) —
        // fold the indented continuation lines into one line
        const cont = [];
        for (let i = descIdx + 1; i < lines.length; i++) {
          if (/^\s+\S/.test(lines[i])) cont.push(lines[i].trim());
          else if (lines[i].trim() === '') continue;
          else break;
        }
        description = cont.join(' ').trim();
      }
    }
  }
  return { name, description };
}

/* Skills that exist on disk without SwarmEye having installed them — the ones
 * an agent writes itself, in a terminal or while running a task. Claude Code
 * already picks these up (they're in a .claude/skills/ it reads), so there's
 * nothing to enable; the Skills screen's job is purely to make them visible
 * and let one be marked auto-invoke. Symlinked entries are skipped on purpose:
 * those are SwarmEye's own repo-skill links (setEnabled/terminalCommand), and
 * listing them again here would double every enabled skill.
 *
 * Two sources, each its own group header: ~/.claude/skills (every agent sees
 * these) and <workspace>/.claude/skills (only agents in that folder do) — the
 * distinction matters for auto-invoke, since a project-local /skill doesn't
 * resolve in an agent running somewhere else. */
const GLOBAL_SOURCE = 'local-global';

function localSkillsIn(dir, { sourceId, sourceLabel, workspaceId = null }) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // isDirectory() is false for a symlink — SwarmEye's own link, skip
    const skillDir = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue;
    const meta = readSkillMeta(skillDir, entry.name);
    found.push({
      id: 'local:' + sourceId + ':' + entry.name,
      repoId: sourceId, // the renderer groups on repoId; a source is a group
      local: true,
      invokeName: entry.name, // what `/x` resolves to — the folder name, not our synthetic id
      workspaceId,
      sourceLabel,
      dir: skillDir,
      name: meta.name,
      description: meta.description,
      enabled: true, // on disk in a .claude/skills Claude Code reads = already live
      active: false, // filled in by listLocal from config
      updateAvailable: false,
    });
  }
  return found.sort((a, b) => a.invokeName.localeCompare(b.invokeName));
}

class SkillsManager {
  constructor({ debugLog }) {
    this.debugLog = debugLog;
    this.root = path.join(app.getPath('userData'), 'skills');
  }

  /* Installed-from-a-repo skills only — what the update/enable/symlink
   * machinery below operates on. Local ones have none of that. */
  _configSkills() {
    return config.load().skills || [];
  }

  /* Re-scanned on every call rather than cached: an agent can create a skill
   * at any moment, and the Skills screen refreshes on open (renderer/skills.js
   * refresh()), which is exactly when a fresh answer is wanted. Two small
   * readdirs per workspace is cheaper than a watcher's bookkeeping. */
  listLocal() {
    const cfg = config.load();
    const activeIds = new Set(cfg.localActiveSkills || []);
    // On Windows the agents' ~/.claude/skills lives inside WSL, which
    // os.homedir() does not point at — scanning the Windows home would list
    // the wrong folder (usually an empty one). Workspace-local skills below
    // are real host paths, so those work on both platforms.
    const found = IS_WIN ? [] : localSkillsIn(path.join(os.homedir(), '.claude', 'skills'), {
      sourceId: GLOBAL_SOURCE,
      sourceLabel: '~/.claude/skills',
    });
    for (const ws of cfg.workspaces || []) {
      if (!ws.path) continue;
      found.push(...localSkillsIn(path.join(ws.path, '.claude', 'skills'), {
        sourceId: 'local-ws-' + ws.id,
        sourceLabel: (ws.name || ws.path) + '/.claude/skills',
        workspaceId: ws.id,
      }));
    }
    for (const s of found) s.active = activeIds.has(s.id);
    return found;
  }

  list() {
    return [...this._configSkills(), ...this.listLocal()];
  }

  _findLocal(id) {
    return this.listLocal().find((s) => s.id === id) || null;
  }

  _skillDir(skill) {
    return skill.relPath ? path.join(this.root, skill.repoId, skill.relPath) : path.join(this.root, skill.repoId);
  }

  /* Every SKILL.md under a freshly-cloned repo, as paths relative to its
   * root ('' for one sitting at the repo root itself). */
  async _findSkillDirs(dest) {
    const out = await exec(
      `find ${shQuote(dest)} -mindepth 1 -maxdepth 4 -type f -iname SKILL.md -not -path '*/node_modules/*' 2>/dev/null`,
      20000
    );
    if (!out) return [];
    return out.trim().split('\n').filter(Boolean).map((p) => {
      const dir = p.slice(0, p.length - '/SKILL.md'.length);
      return dir.slice(dest.length).replace(/^\/+/, '');
    }).sort();
  }

  async install(repoUrl) {
    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) return { ok: false, reason: 'invalid-url' };
    const repoId = slug(parsed.owner + '-' + parsed.repo);
    const cfg = config.load();
    if ((cfg.skills || []).some((s) => s.repoId === repoId)) return { ok: false, reason: 'already-installed' };

    const dest = path.join(this.root, repoId);
    fs.mkdirSync(this.root, { recursive: true });

    const destQ = pathQ(dest);
    if (!destQ) return { ok: false, reason: 'bad-path' };
    const cloneOut = await exec(`git clone --depth 1 ${shQuote(repoUrl)} ${destQ} 2>&1; echo EXIT:$?`, 60000);
    if (cloneOut == null || !/EXIT:0/.test(cloneOut)) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
      this.debugLog('[skills] clone failed for ' + repoUrl + ': ' + (cloneOut || 'shell unreachable'));
      return { ok: false, reason: 'clone-failed' };
    }

    const dirQ = destQ;
    const branch = (await exec(`git -C ${dirQ} rev-parse --abbrev-ref HEAD`) || '').trim() || 'main';
    const commit = (await exec(`git -C ${dirQ} rev-parse --short HEAD`) || '').trim();

    const relPaths = await this._findSkillDirs(toShellPath(dest));
    if (!relPaths.length) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, reason: 'no-skill-md' };
    }

    const found = relPaths.map((relPath) => {
      const skillDest = relPath ? path.join(dest, relPath) : dest;
      const fallbackName = relPath ? path.basename(relPath) : parsed.repo;
      const meta = readSkillMeta(skillDest, fallbackName);
      const id = relPath ? repoId + '-' + slug(path.basename(relPath)) : repoId;
      return {
        id,
        repoId,
        relPath,
        name: meta.name,
        description: meta.description,
        repoUrl,
        branch,
        enabled: false,
        active: false,
        commit,
        updateAvailable: false,
      };
    });
    cfg.skills = [...(cfg.skills || []), ...found];
    config.save(cfg);
    return { ok: true, skills: found };
  }

  async setEnabled(id, enabled) {
    // a local skill is enabled by existing where it does — there's no symlink
    // to add or remove, so there's nothing to toggle
    if (String(id).startsWith('local:')) return { ok: false, reason: 'local' };
    const cfg = config.load();
    const skill = (cfg.skills || []).find((s) => s.id === id);
    if (!skill) return { ok: false, reason: 'not-found' };
    const destQ = pathQ(this._skillDir(skill));
    if (!destQ) return { ok: false, reason: 'bad-path' };
    if (enabled) {
      await exec(`mkdir -p ~/.claude/skills && ln -sfn ${destQ} ~/.claude/skills/${shQuote(id)}`);
    } else {
      await exec(`rm -f ~/.claude/skills/${shQuote(id)}`);
    }
    skill.enabled = !!enabled;
    // a disabled skill can't be auto-invoked at session start (its /id
    // command wouldn't resolve) — active never outlives enabled
    if (!enabled) skill.active = false;
    config.save(cfg);
    return { ok: true, skill };
  }

  /* Active = auto-invoked (`/<id>`) right after every new agent starts,
   * instead of waiting on the model to notice it's relevant on its own.
   * Requires the skill to be enabled first — turning active on enables it
   * too rather than making the user flip both toggles. */
  async setActive(id, active) {
    const cfg = config.load();
    if (String(id).startsWith('local:')) {
      const local = this._findLocal(id);
      if (!local) return { ok: false, reason: 'not-found' };
      const ids = new Set(cfg.localActiveSkills || []);
      if (active) ids.add(id); else ids.delete(id);
      cfg.localActiveSkills = [...ids];
      config.save(cfg);
      return { ok: true, skill: { ...local, active: !!active } };
    }
    const skill = (cfg.skills || []).find((s) => s.id === id);
    if (!skill) return { ok: false, reason: 'not-found' };
    if (active && !skill.enabled) {
      const res = await this.setEnabled(id, true);
      if (!res.ok) return res;
    }
    skill.active = !!active;
    config.save(cfg);
    return { ok: true, skill };
  }

  /* Checks the shared clone once and applies the result to every skill
   * entry sharing it (a multi-skill repo updates as one git repo). */
  async checkUpdate(id) {
    const cfg = config.load();
    const skill = (cfg.skills || []).find((s) => s.id === id);
    if (!skill) return false;
    const dirQ = pathQ(path.join(this.root, skill.repoId));
    if (!dirQ) return null;
    const out = await exec(
      `git -C ${dirQ} fetch --quiet origin ${shQuote(skill.branch)} 2>/dev/null && ` +
      `git -C ${dirQ} rev-parse HEAD && git -C ${dirQ} rev-parse ${shQuote('origin/' + skill.branch)}`,
      30000
    );
    let updateAvailable = skill.updateAvailable || false;
    if (out) {
      const lines = out.trim().split('\n').filter(Boolean);
      updateAvailable = lines.length === 2 && lines[0] !== lines[1];
    }
    for (const s of cfg.skills || []) {
      if (s.repoId === skill.repoId) s.updateAvailable = updateAvailable;
    }
    config.save(cfg);
    return updateAvailable;
  }

  /* Fires one check per distinct repo (not per skill entry — a multi-skill
   * repo would otherwise re-fetch once per skill) without waiting on each
   * other, then fans each result out to every sibling id so the Skills
   * screen can light up "Update" buttons as results trickle in. */
  checkAllUpdates(onEach) {
    const seenRepo = new Set();
    for (const skill of this._configSkills()) {
      if (seenRepo.has(skill.repoId)) continue;
      seenRepo.add(skill.repoId);
      this.checkUpdate(skill.id).then((updateAvailable) => {
        for (const s of this._configSkills()) if (s.repoId === skill.repoId) onEach(s.id, updateAvailable);
      }).catch(() => {});
    }
  }

  /* Pulls the shared clone once, then re-parses every sibling skill's own
   * SKILL.md (each can change independently even though the pull is one
   * git operation). */
  async update(id) {
    const cfg = config.load();
    const skill = (cfg.skills || []).find((s) => s.id === id);
    if (!skill) return { ok: false, reason: 'not-found' };
    const cloneDir = path.join(this.root, skill.repoId);
    const dirQ = pathQ(cloneDir);
    if (!dirQ) return { ok: false, reason: 'bad-path' };
    const out = await exec(`git -C ${dirQ} pull --ff-only 2>&1; echo EXIT:$?`, 30000);
    if (out == null || !/EXIT:0/.test(out)) return { ok: false, reason: 'pull-failed' };

    const branch = (await exec(`git -C ${dirQ} rev-parse --abbrev-ref HEAD`) || '').trim() || skill.branch;
    const commit = (await exec(`git -C ${dirQ} rev-parse --short HEAD`) || '').trim() || skill.commit;
    for (const s of cfg.skills || []) {
      if (s.repoId !== skill.repoId) continue;
      const meta = readSkillMeta(this._skillDir(s), s.name);
      s.name = meta.name;
      s.description = meta.description;
      s.branch = branch;
      s.commit = commit;
      s.updateAvailable = false;
    }
    config.save(cfg);
    return { ok: true, skill: cfg.skills.find((s) => s.id === id) };
  }

  /* Drops just this entry (and its symlink); the shared clone is only
   * deleted from disk once no sibling skill still references it. */
  async remove(id) {
    const cfg = config.load();
    /* A local skill has no clone to fall back on — removing it means deleting
     * the folder the agent wrote. The Skills screen arms this behind a
     * click-twice confirm like every other destructive button there. */
    if (String(id).startsWith('local:')) {
      const local = this._findLocal(id);
      if (!local) return { ok: false, reason: 'not-found' };
      try { fs.rmSync(local.dir, { recursive: true, force: true }); } catch { return { ok: false, reason: 'delete-failed' }; }
      cfg.localActiveSkills = (cfg.localActiveSkills || []).filter((x) => x !== id);
      config.save(cfg);
      return { ok: true };
    }
    const skill = (cfg.skills || []).find((s) => s.id === id);
    if (!skill) return { ok: false, reason: 'not-found' };
    await exec(`rm -f ~/.claude/skills/${shQuote(id)}`);
    cfg.skills = (cfg.skills || []).filter((s) => s.id !== id);
    if (!cfg.skills.some((s) => s.repoId === skill.repoId)) {
      try { fs.rmSync(path.join(this.root, skill.repoId), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    config.save(cfg);
    return { ok: true };
  }

  /* Removes every skill sharing repoId in one shot — same net effect as
   * calling remove() for each entry, but the shared clone is only ever
   * deleted once instead of racing remove()'s per-skill "last one out"
   * check. */
  async removeRepo(repoId) {
    const cfg = config.load();
    const toRemove = (cfg.skills || []).filter((s) => s.repoId === repoId);
    if (!toRemove.length) return { ok: false, reason: 'not-found' };
    const rmCmd = toRemove.map((s) => `rm -f ~/.claude/skills/${shQuote(s.id)}`).join(' && ');
    await exec(rmCmd);
    cfg.skills = (cfg.skills || []).filter((s) => s.repoId !== repoId);
    try { fs.rmSync(path.join(this.root, repoId), { recursive: true, force: true }); } catch { /* ignore */ }
    config.save(cfg);
    return { ok: true };
  }

  /* Boot-time: re-link every still-enabled skill, in case ~/.claude/skills
   * was wiped or a symlink was deleted by hand. */
  async ensureSymlinks() {
    const enabled = this._configSkills().filter((s) => s.enabled);
    if (!enabled.length) return;
    const links = enabled
      .map((s) => {
        const q = pathQ(this._skillDir(s));
        return q ? `ln -sfn ${q} ~/.claude/skills/${shQuote(s.id)}` : '';
      })
      .filter(Boolean)
      .join(' && ');
    if (links) await exec(`mkdir -p ~/.claude/skills && ${links}`);
  }

  /* Copy-paste command for a disabled skill: symlinks it into just the
   * current project instead of every agent everywhere. */
  terminalCommand(id) {
    const skill = this._configSkills().find((s) => s.id === id);
    if (!skill) return '';
    return `mkdir -p .claude/skills && ln -sfn "${toShellPath(this._skillDir(skill))}" .claude/skills/${id}`;
  }
}

module.exports = { SkillsManager };
