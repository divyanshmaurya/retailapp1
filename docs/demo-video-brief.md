# S.Mart Retail AI — 3-minute executive demo video

Production brief for a 180-second narrated demo, assembled from real application screenshots plus
generated b-roll. Written for the Higgsfield tools available in Claude. Female voiceover.

Audience: customer and partner executives. Register: confident, specific, no hype. The application
is the proof; the generated artifacts only carry the viewer between screens.

---

## Before you start — two things that will otherwise ruin the video

**1. Never send an application screenshot through `generate_video`.** Image-to-video models resample
every frame, and the first thing that dissolves is small UI text — column headers turn to nonsense,
euro figures become invented digits, the SAP Fiori shell warps. To an executive who knows the
product this reads as a fake. All seventeen screenshots stay **stills**, and their movement comes
from a slow scale/pan applied at assembly time. Only the abstract b-roll (shots B1–B4) is generated
as motion.

**2. Say what the data is.** The figures are computed from a dataset synthesized from two real SAP
Customer Checkout exports — genuine structure, modelled volumes. Shown to a customer without that
label, €3,107.53 at risk in Munich reads as a production result from a live store. The end card
carries the line; keep it legible, not a two-frame flash. It costs nothing and it protects the
claim.

---

## Assets

Screenshots supplied. `10.png`, `12.png` and `13.png` are duplicates of `3.png`, `7.png` and
`11.png` — used below as second angles where a segment needs two beats on the same screen.

| File | Screen |
|---|---|
| `1.png` | Overview — hero KPI strip and Start Here cards |
| `2.png` | Overview — seven scenario cards and the Fiori Elements applications |
| `3.png` / `10.png` | Command Centre — network KPIs, value at stake by scenario, integrity by pattern |
| `4.png` | Command Centre — trading by hour, channel mix, model scorecard |
| `5.png` | Command Centre — ranked insight feed |
| `6.png` | Checkout Integrity Radar — Munich Werksviertel, 129 alerts, €3,107.53 |
| `7.png` / `12.png` | API Explorer — AIService entities |
| `8.png` | API Explorer — AnalyticsService entities |
| `9.png` | API Explorer — query runner and actions |
| `11.png` | Checkout Integrity Radar — all stores, 500 alerts, €12,980 |
| `14.png` | Replenishment Cockpit |
| `15.png` | AI Insight Feed — 107 insights |
| `16.png` | SAP Fiori Elements — Checkout Integrity Radar list report |
| `17.png` | SAP Fiori Elements — Fresh Waste Guard list report |

To be generated: `B1`–`B4` b-roll, `T1` title card, `E1` end card, `VO` narration.

---

## Shot list

Total 180 s. Timings are cuts, not suggestions — the voiceover is written to this grid.

| # | In–Out | Visual | On-screen text | Motion |
|---|---|---|---|---|
| 1 | 0:00–0:07 | **B1** autonomous store, dark, sensor light | — | slow drift forward |
| 2 | 0:07–0:14 | **T1** title card | S.MART RETAIL AI / Autonomous retail, instrumented | logo settle, no motion after 0:11 |
| 3 | 0:14–0:23 | **B2** shelf-edge macro, price label | — | slow lateral push |
| 4 | 0:23–0:32 | **B3** chiller aisle, cold blue | Individually invisible. Together, material. | slow rise |
| 5 | 0:32–0:44 | `1.png` | — | push in 100→108 %, centred on KPI strip |
| 6 | 0:44–0:52 | `1.png` | callout ring on **Value at stake** and **Forecast accuracy** | hold, callouts fade in 0:45 / 0:48 |
| 7 | 0:52–1:06 | `2.png` | SEVEN AI SCENARIOS | pan down, 108→100 % |
| 8 | 1:06–1:18 | `3.png` | — | push in on the two charts |
| 9 | 1:18–1:30 | `4.png` | MODEL SCORECARD | pan right across scorecard |
| 10 | 1:30–1:37 | `5.png` | — | push in on top three rows |
| 11 | 1:37–1:44 | `15.png` | 107 INSIGHTS · ONE QUEUE | slow pull back |
| 12 | 1:44–1:53 | `11.png` | — | hold, then push toward the KPI row |
| 13 | 1:53–2:06 | `6.png` | S.MART MUNICH WERKSVIERTEL | cross-dissolve from 11, settle on 129 / €3,107.53 |
| 14 | 2:06–2:20 | `14.png` | FORECAST → ORDER | pan across urgency, units, supplier |
| 15 | 2:20–2:27 | `16.png` | STANDARD SAP FIORI | push in on the action bar |
| 16 | 2:27–2:34 | `17.png` | — | push in on markdown % and recovery |
| 17 | 2:34–2:41 | `7.png` | — | slow pan down the entity list |
| 18 | 2:41–2:47 | `8.png` | TWO ODATA V4 SERVICES | slow pan down |
| 19 | 2:47–2:52 | `9.png` | — | push in on the actions block |
| 20 | 2:52–2:56 | **B4** wide store, warm dawn | — | slow drift, motion stops at 2:55 |
| 21 | 2:56–3:00 | **E1** end card | S.MART RETAIL AI / SAP CAP · SAP HANA Cloud · SAP Fiori + disclaimer | static |

Cuts: hard cuts throughout except 12→13, which cross-dissolves over 8 frames because it is the same
screen narrowing to one store. Do not dissolve between different screens; it reads as a slideshow.

---

## Voiceover script

324 words across 180 s — 108 wpm overall, deliberately unhurried. Measured per segment it runs
between 80 and 128 wpm, so no shot is over-stuffed and the opener and closer carry music-only slack.
Female, mid-to-low register, calm and declarative, the tone of someone briefing rather than selling.
No upward inflection at line ends. `//` marks a beat, not a written pause.

If the rendered voiceover comes back long, cut words rather than speeding the delivery up — the
grid is what the picture is cut to, and a rushed read is the single clearest tell of an AI-assembled
demo.

> **[0:00]** Six stores. A hundred and twenty thousand rows of checkout data. // And nobody with the
> hours to read it.
>
> **[0:14]** In autonomous retail, losses don't arrive as one big event. They arrive as a mispriced
> shelf label. A tag the gate never read. A chiller drifting two degrees overnight. // Individually
> invisible. Together, material.
>
> **[0:32]** S.Mart Retail AI reads that data and puts a number on it. Value at stake. Open
> insights. What needs attention first. // Every figure on this page is computed live from SAP HANA
> Cloud. Nothing here is typed in.
>
> **[0:52]** Behind it, seven AI scenarios — checkout integrity, replenishment, fresh waste, demand
> forecasting, basket affinity, personalised offers and cold chain. Each also delivered as a standard
> SAP Fiori Elements application.
>
> **[1:06]** The Command Centre is where an operations lead starts the day. Value at stake by
> scenario. Checkout integrity broken down by failure pattern. The trading curve hour by hour, the
> channel mix — // and a model scorecard, because a forecast you cannot audit is not a forecast.
>
> **[1:30]** A hundred and seven insights, in a single queue. Ranked by euros at stake, weighted by
> how much the model trusts its own call.
>
> **[1:44]** Every insight opens onto its evidence. Checkout Integrity Radar across the network —
> // then filtered to a single store. Munich Werksviertel: a hundred and twenty-nine alerts, three
> thousand one hundred euros at risk. Each one with its failure pattern, its anomaly score, and the
> action to take.
>
> **[2:06]** The Replenishment Cockpit turns the forecast into orders. Units to order, stockout
> risk, supplier, lead time — released from the same screen.
>
> **[2:20]** For teams already working in SAP, the same data arrives as Fiori list reports.
> Acknowledge, resolve, apply a markdown — without leaving the pattern they already know.
>
> **[2:34]** And none of it is closed. Two OData services expose every AI output and every
> operational dataset, actions included, for any client to call.
>
> **[2:52]** S.Mart Retail AI. // Built on SAP CAP and SAP HANA Cloud.

### Pronunciation

- **S.Mart** — "ess-mart", two beats, not "smart".
- **Werksviertel** — "VAIRKS-feer-tel".
- **Walldorf** — "VAL-dorf".
- **€3,107.53** — read as "three thousand one hundred euros"; do not read the cents.
- **SAP** — three letters, "ess-ay-pee". **CAP** — as a word, "cap". **OData** — "oh-data".

---

## Generation prompts

### Voiceover

Pick the voice first — `list_voices`, then choose a female voice described as calm, warm, mid-low,
documentary or corporate-narration. Avoid anything tagged bright, bubbly or upbeat; it fights the
subject. Render the script in one pass so the pacing is internally consistent, then cut to the grid.

```
generate_audio
voice: <chosen female voice id>
style: measured corporate documentary narration, calm and authoritative, unhurried,
       clear consonants, no upward inflection at line ends, slight warmth
text: <the voiceover script above, // replaced with a half-second pause>
```

### B-roll — `generate_image`, then `generate_video` for motion

Shared look, repeat in every prompt: *cinematic, anamorphic, shallow depth of field, cool
desaturated palette with a single warm accent, volumetric light, photographic realism, no people's
faces, no legible text or signage, 16:9.*

- **B1** — "Interior of a modern unstaffed convenience store at night, overhead sensor arrays and
  ceiling cameras picking out empty aisles, faint cyan indicator lights along the shelf edge, glass
  frontage reflecting the street. Cold, quiet, surveilled, expensive."
- **B2** — "Extreme macro of a supermarket shelf edge, an electronic shelf label glowing out of
  focus, packaged goods receding into bokeh, single warm rim light along the rail."
- **B3** — "Refrigerated aisle in a supermarket, glass chiller doors, condensation on the inside,
  cold blue light spilling onto a polished floor, thermal haze at the top of the frame."
- **B4** — "Wide establishing shot of a small urban store frontage at dawn, warm interior light
  against a blue-grey street, city waking up, shot from across the road."

Then animate each still:

```
generate_video  (image-to-video, from B1..B4)
duration: 8s
motion: almost imperceptible camera move only — slow forward drift / lateral push as noted
        in the shot list. Locked-off subject. No people entering frame, no objects moving,
        no camera shake, no zoom snap, no text appearing.
```

Keep the motion under-driven. The most common failure here is a b-roll shot with more energy than
the screens it introduces, which makes the product look static by comparison.

### Title and end cards — `generate_image`

- **T1** — "Minimal corporate title card, near-black background with a very subtle dark blue
  gradient from the lower left, a thin horizontal rule in muted cyan, generous negative space,
  clean geometric sans-serif layout, no logo marks, no illustration, 16:9." Composite the text at
  assembly so the type is sharp and correctly spelled: **S.MART RETAIL AI** with
  *Autonomous retail, instrumented* beneath it.
- **E1** — same background family, slightly lighter. Composite at assembly:
  - **S.MART RETAIL AI** (primary)
  - *SAP CAP · SAP HANA Cloud · SAP Fiori Elements · OData V4* (secondary)
  - *Illustrative dataset synthesized from SAP Customer Checkout exports.* (footnote, small but
    readable — roughly half the secondary line's size, not smaller)

Generate card **backgrounds** only and lay the type over them in the edit. Image models mangle
long strings, and a title card with a typo in the product name is the one frame everyone remembers.

---

## Assembly

**Music.** One bed, 180 s, instrumental: restrained corporate-documentary, soft synth pad with a
low pulse, no drop, no vocal, no orchestral swell. Duck to about −18 dB under narration and lift in
the two speech gaps (0:11–0:14 and 2:52–2:56). Fade the last two seconds to silence under the end
card rather than cutting.

**Screenshot movement.** 2–4 % of scale over the shot's full length, one direction, ease-in-out at
both ends. Start from a scale above 100 % so nothing soft-edges. Never move and cut on the same
frame.

**Callouts.** Shot 6 only — a thin 2 px ring in the accent cyan around the two KPI tiles, fading in
over 6 frames. No arrows, no drop shadows, no animated pointers. One callout style, used twice, is
more convincing than five.

**Legibility.** Check every screenshot shot at 50 % of a 1080p frame — mobile viewers and inline
email players. If a figure the narration names is not readable at that size, push in further or drop
the number from the voiceover. Do not shrink the frame to fit more of the screen in; a
partially-shown screen read clearly beats a whole screen read never.

**Deliverables.** 1920×1080, H.264, 25 fps. Also export a 1:1 crop for LinkedIn if this is going
beyond the executive audience, and burn open captions into that version — social players start
muted, and a demo whose narration nobody hears is thirty seconds of unexplained tables.

---

## Figure provenance

Every number in the script, and where it comes from, so this can be re-checked when the dataset
changes:

| Claim | Value | Source |
|---|---|---|
| Rows in SAP HANA Cloud | 120,324 | HDI deploy log; 25 seed CSVs under `db/data/` |
| Stores | 6 | `smart.retail-Stores.csv` |
| AI insights, all open | 107 | `smart.retail-AIInsights.csv` |
| Need attention (critical + high) | 58 | same file, severity in {CRITICAL, HIGH} |
| Value at stake | €1,733 | sum of `impactValue` over open insights, as `app/index.html` computes it |
| Forecast accuracy | 71.2 % | 100 − WAPE (store-day) 28.83, `smart.retail-ModelMetrics.csv` |
| AI scenarios | 7 | checkout integrity, replenishment, fresh waste, demand forecast, basket affinity, personalised offers, cold chain — one engine each under `srv/lib/engines/` |
| Fiori Elements applications | 8 | `app/` — one per scenario plus the insight feed |
| OData V4 services | 2 | `AIService` (`/ai`), `AnalyticsService` (`/analytics`) |
| Munich alerts / at risk | 129 / €3,107.53 | on screen in `6.png` |
| All-store alerts / at risk | 500 / €12,980 | on screen in `11.png` — the first 500 rows, not the full 676 |

Two figures to keep straight, because mixing them up is the easiest way to overstate the case: the
Overview's **value at stake is €1,733**, the sum of open insight impacts. The **€17,225** in
`ModelMetrics` is total checkout exposure across all 676 shrink alerts — a different measure. The
narration quotes neither total; it quotes only what is legible on the screen being shown.

---

## The prompt to paste into Claude

Attach `1.png`–`17.png` in the same message, then send this. It assumes the Higgsfield tools are
available; the first instruction makes Claude load the workflow guidance before generating anything,
which is what the tooling asks for on multi-step narrated video.

```
Build a 3-minute (180 second) professional demo video for our SAP retail application,
"S.Mart Retail AI", for presentation to customer and partner executives.

Start by calling get_workflow_instructions to load the narrated-explainer workflow, then
follow docs/demo-video-brief.md in this repository as the production brief. It contains the
full shot list with timings, the voiceover script, the b-roll and card prompts, and the
assembly notes. Follow the timing grid exactly.

The 17 attached screenshots are real screens from the application. Use them as STILLS only —
do not pass them through generate_video, because image-to-video warps UI text and invented
numbers on screen would discredit the whole video. Their movement is a slow 2-4% scale or pan
applied at assembly. Only the four b-roll shots are generated as motion.

Voiceover: female, mid-to-low register, calm and authoritative, measured corporate-documentary
delivery. Call list_voices and pick accordingly before rendering. Use the script in the brief
verbatim, including the pronunciation notes.

Generate: four b-roll shots (B1-B4), a title card background, an end card background, the
voiceover, and one 180-second instrumental music bed. Composite all card text at assembly
rather than asking an image model to render it.

The end card must carry the line "Illustrative dataset synthesized from SAP Customer Checkout
exports." at a readable size. This is not optional - the figures are modelled, and the video
goes to customers.

Deliver 1920x1080 H.264 at 25 fps.
```

If the brief is not in the working directory of that session, paste the shot list, voiceover script
and generation prompts inline instead — everything the prompt refers to is in this file.
