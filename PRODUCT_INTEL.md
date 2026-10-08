# Product intelligence

This branch turns competitor screenshots or an OpenScreen recording into contextual product research. Drop screenshots, describe your product, connect Gemini, and analyze. Screenshot reports propose names and groups, explain visible evidence, and suggest product experiments. Recording reports add source timestamps. The main findings are ordered by relevance to the supplied product brief.

This is a personal local Mac build. Live Gemini analysis has not been verified in this development session because no API key was available. Model availability, account quota, and results from real recordings still need a live check. This branch does not provide a competitor library or comparisons across saved competitors.

## Ten foundational changes

1. Screenshot-first workspace with recording on a separate tab.
2. Advanced editor, project controls, and settings hidden under More.
3. Direct video import and access to the existing screen recorder.
4. Multi-image import and drag-and-drop with a persistent local library.
5. One shared product brief for audience, job, constraints, and differentiators.
6. Native Gemini video analysis with source timestamp evidence.
7. Native Gemini vision analysis for unordered screenshots.
8. Editable analyst instructions and recording focus presets.
9. AI screen labels and semantic folders applied to organized copies.
10. Evidence viewers, confidence and unknowns, portable reports, and optional automatic analysis of new recordings.

## Get started on macOS

Use Node 22.22.1, npm 10.9.4, and the GitHub CLI (`gh`). The setup script downloads the upstream v2.0.0 native Mac payload for the current arm64 or x64 architecture, verifies its checksum, and stages it locally. It checks that native sources still match that release; if they have changed, build the native helpers from source instead.

```sh
git clone --branch competitor-intel-v2 https://github.com/dakshbhatia/openscreen.git
cd openscreen
npm run setup:intel:mac
npm run build:intel:mac
```

The build produces a local app bundle under `release/2.0.0/`. The command uses `--publish never`; it does not publish a release. For development after setup, run `npm run dev`.

The fork uses its own `product-intel` application data directory, separate from an existing OpenScreen installation.

The app opens directly into a minimal research workspace. **Screenshots** is the default input; **Recording** retains the screen recorder and video import. Add your audience, job to be done, constraints, and differentiators under **Our product**, then analyze. Gemini connection setup stays under **More**, or **Research settings** in recordings; Analyze reveals it when a key is missing. Additional context, model/custom prompts, history, and the full editor remain available under **More**.

Screenshot batches accept up to 24 PNG/JPEG/WebP images, 8 MB each and 24 MB combined. The app copies them into its local library and sends resized images to Gemini vision. It validates that every supplied image is described exactly once. Names and semantic groups apply to organized copies, preserving your original files. Unordered images do not establish click order, transitions, or task completion. Use **Open organized folder** after analysis to find the grouped, named copies.

Timestamp links seek within the original source recording, independent of timeline cuts and zooms. The report gives a few findings first, with the remaining findings and journey available to inspect. Markdown export uses consistent headings and includes context, evidence, confidence, unknowns, and report metadata for review alongside other exported reports. It excludes the custom system prompt and uses an explicit metadata allowlist; unmistakable Gemini keys and common local filesystem paths found in prose are marked `[redacted]`.

## Data and limits

Analysis sends the complete source recording and supplied context to Google using the connected key and API quota. Automatic analysis is optional and applies to new recordings. Settings and reports are saved locally. The service attempts to delete the uploaded remote file after the request; the report records whether deletion was confirmed.

A recording can show a product interaction. It cannot establish conversion, retention, revenue, backend implementation, or causal impact. The default prompt asks for feasible experiments and context-fit tradeoffs without invented baselines or projected lift. Low-confidence findings and unknowns need follow-up evidence. Review reports before sharing them, especially when a recording contains personal or confidential information.

## Focused checks

```sh
npx vitest --run src/lib/product-intel.test.ts src/lib/product-intel-export.test.ts
npx vitest --run electron/ai-edition/product-intel-service.test.ts src/components/ai-edition/ProductIntelPanel.test.tsx
npx vitest --run src/lib/screenshot-intel.test.ts electron/ai-edition/screenshot-intel-service.test.ts electron/ipc/nativeBridge.screenshots.test.ts src/components/ai-edition/ScreenshotBoard.test.tsx
```

## Technical references

- [Google video understanding documentation](https://ai.google.dev/gemini-api/docs/video-understanding)
- [Google image understanding documentation](https://ai.google.dev/gemini-api/docs/image-understanding)
- [Google generateContent API reference](https://ai.google.dev/api/generate-content)
- [Upstream OpenScreen repository, MIT license](https://github.com/getopenscreen/openscreen)
