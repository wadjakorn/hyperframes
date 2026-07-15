# Karaoke captions — word-by-word active highlight (opt-in)

**Karaoke** = every word of a group lights in sequence as it's spoken (dim → bright,
left-to-right, wrapping to line 2 in reading order). It's the signature look of loud
social / Reels / TikTok captions.

**This is NOT the default rail.** [rail.md](rail.md) is deliberately restrained: the rail
carries `emphasis` on the 1–2 punch words only and reserves per-word choreography for the
embed track. Reach for full karaoke **only** when a loud / high-energy identity asks for it
(social cutdowns, hype edits, `loud` / `velocity`-register work) — not on explainer /
documentary / keynote, where it reads as noise. When you do use it, the rules below make it
correct instead of the two things that always go wrong: **reading order** and **timing**.

## Implement per-token, never as a single wipe

The correctness core, and the mistake to avoid:

- **Wrong:** stack two copies of the caption (dim base + bright fill) and reveal the fill with
  one animated `clip-path: inset(...)` / mask / background-position sweep. A horizontal wipe
  reveals a **wrapped block column-wise** — on a 2-line caption it fills both lines' left
  halves at once. It reads as "both lines highlighting together," not word-by-word. (See
  [anti-patterns.md § multi-line highlight wipe](anti-patterns.md).)
- **Right:** wrap each word (or short phrase) in its **own** `<span class="tok">`, then drive a
  timeline that snaps each token dim→bright **in DOM order**. Reading order is preserved for
  free, and wrapping to the next line just works — the highlight follows the text.

```html
<div class="cap"><span class="tok">Every</span> <span class="tok">word</span> <span class="tok">is</span> <span class="tok">its</span> <span class="tok">own</span> <span class="tok">span</span></div>
```

```js
// dim by default; snap to accent as each token's moment arrives. Color tween, not a mask.
toks.forEach((tok, i) => {
  tl.fromTo(tok, { color: DIM }, { color: LIT, duration: 0.14, ease: "none" }, tokenTime(i));
});
```

Seek-safe by construction: GSAP interpolates each token by playhead, so scrubbing backward
un-lights correctly (the hyperframes determinism contract still holds — no `Date.now()` /
random). A snap (`ease:"none"`, ~0.12–0.16s) reads crisper than a slow fade.

## Timing — use word timings when trustworthy, even cadence when not

Karaoke wants a per-word onset. You have two sources:

- **Word-level transcript** (`transcript.json` `words[]`, 80ms gate) — use it directly when the
  ASR gave clean per-word stamps. `tokenTime(i)` = that word's `start`.
- **Even cadence across the group window** — the fallback when per-word stamps are unreliable.
  **Whisper fragments unspaced scripts (Thai, Japanese, Chinese) into per-character/syllable
  tokens with many identical or zero-duration stamps** — useless for a per-word onset. Don't
  fake precision from them. Instead distribute the tokens **evenly** across the group's known
  window: `tokenTime(i) = start + (dur - tail) * i / n`. It won't match the audio to the frame,
  but it reads as karaoke and never drifts absurdly. **Tell the user it's even-cadence** and
  offer per-line hand-tuning.

Tokenizing mixed scripts: split plain runs on whitespace; keep a tagged proper-noun span
(e.g. a bilingual term like "Claude Code") as **one** token so it lights as a unit.

## Placement — respect the platform HUD (vertical)

Karaoke is almost always portrait 9:16 for social. The platform paints UI over the frame:

- Keep the **right ~15–18%** clear (the like / comment / share action column).
- Keep the **bottom ~20–22%** clear (caption / username / audio bar).
- Put the caption band in the **mid-lower** area, **bottom-anchored** so a 2-line group grows
  upward from a stable edge and never creeps into the bottom HUD. This is the same title-safe
  discipline as [rail.md § Position & safe area](rail.md), just biased up and away from the right rail.

Verify with a still, not by eye: `node scripts/preview-frames.cjs <project>` (or
`hyperframes snapshot --at <t>`) at a moment a 2-line group is mid-sweep, and confirm line 1 is
fully lit before line 2 begins.
