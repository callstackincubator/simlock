<!--
Refactor spec (delivery rule 18). A refactor changes structure, never
behaviour, so it needs no Technical spec and no spec check. It is
refactor:new until the maintainer, or the refactor routine under rule 18's
three conditions, sets refactor:ready.
-->

## Why

<!-- One or two sentences: what is hard today and what this makes easier.
From the refactor routine: the measurement, as the command and the output
line it printed. -->

## Target shape

<!-- What moves where, or what replaces what, one bullet per file or
symbol: "`startEmulator` and its helpers move to `src/drivers/android/emulator.ts`".
Name the accepted ADR it follows, if one does. Never a new behaviour. -->

## Out of bounds

<!-- The modules and files it must not touch. Every module's index.ts
exports, the surface files, the protocol version and the ADRs are out of
bounds already; list what else. -->

## Done when

<!-- Structural checks only, one bullet each, such as "no file in
`src/daemon/` over 1,400 lines" or "`retryWithBackoff` has one definition
and three callers". Never a behaviour: behaviour does not change. -->
