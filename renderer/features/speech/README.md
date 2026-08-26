# `renderer/features/speech/`

Push-to-talk dictation.

Wires a button to the Whisper bridge in `main/speech.js`. Hold to talk, not a
toggle: an app-wide mic left open listens to the room. Interim results show as
they arrive, and the top match is never run for you — a mishearing would
otherwise spawn or close an agent.

The top bar's mic fills the command palette's box, so speech reaches every verb
the palette already has without a second intent layer.

## Files

`speech.js`

## Public interface

`Speech.wire(button, { interim, hold, onStart, onResult })`. A classic
script.

## How to test

Run `scripts/setup-stt.sh` once, then hold the mic in the top bar and say
"task board". The palette should fill in as you speak and need an explicit Enter
to run.
