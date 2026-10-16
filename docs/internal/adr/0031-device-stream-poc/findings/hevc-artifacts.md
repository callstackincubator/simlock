# HEVC motion artifact investigation — 2026-10-16

The user reports corruption during scrolling/transitions with both decoder modes.
The captured native `decoded-180.png` is already corrupt before preview rendering.
The 1792084498-software-A95E74 capture contains 234 complete pictures (one IDR,
233 P pictures). Independent reconstruction of its raw RTP records exactly matches
all 2,791,594 bytes of assembled.hevc. There are no RTP sequence gaps. Runtime
counters also show no decoder drops. The capture has no long-term references in
its SPS; disabling LTRP did not resolve the issue. Earlier sample metadata and
presentation timing corrections also did not resolve it.

Current candidate: change the HEVC capability advertisement. Local runtime
inspection confirmed that CoreDevice screen settings expose featureListString as
a dictionary keyed by RTP payload number: 100 -> FLS;VRAE:0;SW:1; and
123 -> FLS;SW:1;. The idevice implementation explicitly reports screen tearing
with the default HEVC feature string and uses an alternative. The demo now wraps
the existing screen settings getter, changing only key 100. This changes the
negotiator's own local state before offer creation, keeping it consistent with
its outgoing offer. H.264 settings and the existing LTRP setting are preserved.

Reference: https://docs.rs/idevice/latest/src/idevice/services/core_device/display_stream/negotiation.rs.html

This is a candidate fix, not a confirmed root cause. No phone interaction or live
stream test was performed. Build and launch only; user verifies scrolling and
transitions. The log records the negotiated codec string and bounded local
captures remain enabled. If it persists, compare the next negotiated string and
native decoded frames before choosing another change.

Rollback source: work/pre-hevc-capabilities/MediaBridge.m
