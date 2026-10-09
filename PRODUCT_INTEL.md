# Product intelligence

This branch turns competitor screenshots or an OpenScreen recording into contextual product research. Connect Gemini once, then drop screenshots to analyze and organize automatically. The app infers the visible competitor product and job; a company domain or written brief is optional. Screenshot reports propose names and groups, explain visible evidence, and suggest product experiments. New recording reports use the same compact brief, with grouped product pieces and source timestamps. The main findings are ordered by relevance to supplied company context and the strongest evidence.

This is a personal local Mac build. Live Gemini 3.8 Flash analysis passed for a six-image batch, a synthetic two-second video and a ten-second synthetic product recording. The latest recording returned six purpose-labeled pieces, a strength, a friction point and a next action with valid timestamps and confirmed remote-file deletion. The new structured screenshot analysis also passed with an empty written brief and provider-confirmed retrieval of an optional public company domain. The bulk path passed a live 25-screen collection through two image requests and one synthesis request, with complete coverage, valid citations, small previews and five consistent purpose groups. The 120-screen limit is covered in automated provider and UI tests. Screenshot naming, grouping and organized copies were verified in the packaged app, including connection persistence after restart. The permission recovery card opened the correct macOS pane; screen access remains off on this Mac. Real screen capture, audio/camera and long-recording analysis still need a device-level pass. This branch does not provide a competitor library or comparisons across saved competitors.

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

## Workflow refinements

The next ten changes make the existing research workspace easier to use:

1. Product context autosaves after editing, with saving/saved feedback and retry on disk errors.
2. Product context opens compactly; Edit reveals the optional company domain and exact brief wording.
3. Summaries and advice use short previews; full text remains available in the summary and evidence inspector.
4. Search matches screen names, original filenames, observations, hypotheses and advice locally.
5. Group filters combine with search and can be cleared together.
6. Evidence has previous/next controls and left/right arrow navigation within the filtered screens.
7. Unknowns sit beside product takeaways in a collapsed section.
8. New imports skip byte-identical copies within that batch and show how many were skipped. Existing batches and original files are preserved; visually similar images are retained.
9. Gemini HTTP errors distinguish access, quota, model/request and temporary service failures without exposing provider response bodies.
10. History labels include screen purposes, count, date and unanalyzed status without another AI request.

## Get started on macOS

Use Node 22.22.1, npm 10.9.4, and the GitHub CLI (`gh`). The setup script downloads the upstream v2.0.0 native Mac payload for the current arm64 or x64 architecture, verifies its checksum, and stages it locally. It checks that native sources still match that release; if they have changed, build the native helpers from source instead.

```sh
git clone --branch competitor-intel-v2 https://github.com/dakshbhatia/openscreen.git
cd openscreen
npm run setup:intel:mac
npm run build:intel:mac
```

The build produces a local app bundle under `release/2.0.0/`. The command uses `--publish never`; it does not publish a release. For development after setup, run `npm run dev`.

Product Intel uses a shared screen-and-lens mark for the app, header and favicon. Run `node scripts/generate-product-intel-icons.mjs` after changing `public/product-intel.svg` to regenerate the PNG and Windows icons, and the macOS icon when running on a Mac.

The fork uses its own `product-intel` application data directory, separate from an existing OpenScreen installation. Keys are saved with Electron OS encryption, never as plaintext. For a one-time local provisioning run, an administrator can set `PRODUCT_INTEL_SAVE_GEMINI_KEY=1` and a supported Google key environment variable when launching the app executable. This preserves an existing stored key, clears the bootstrap environment before provider initialization, and refuses storage if OS encryption is unavailable. Keep credentials out of shell arguments and source files. Normal launches use the encrypted saved key.

## One focused product brief

New screenshot reports open as one product brief: what the product does and the job it supports, what works well, what may create friction, and one recommended next step. Each screenshot explains its purpose. Strengths and friction are judged against the user and job; each cites source screens and distinguishes visible evidence from inference. Thin evidence may produce no supported strength, friction or decision.

The first strength, friction point and next step appear up front; additional findings, decisions and deeper reasoning stay collapsed. Recommendations can be adopt, adapt, avoid, or investigate, with rationale, counterevidence, a small experiment and a tradeoff. Inspect evidence to browse only cited source screens. Screens remain an unordered collection and do not establish flow chronology. Audience and confidence remain available under the product understanding disclosure.

A company domain under **More → Our product → Edit** is optional. Gemini URL Context retrieves the public homepage during analysis to ground advice in your company. Retrieval status and source links come from Google's response metadata, not model prose. Failed or unconfirmed retrieval is shown explicitly; without supplied company context, recommendations remain investigations. The inferred competitor understanding never silently becomes your company brief. Written context and saved custom prompts retain their exact wording; application reasoning rules accompany them on requests.

Search includes screen purpose and strength/friction/decision reasoning through cited screens. Portable JSON and Markdown include the same focused brief, purposes, decisions, evidence IDs and verified company sources, while excluding private prompts and local paths. Existing reports remain readable and are only updated when you explicitly analyze them again.

The app opens directly into a minimal research workspace. **Screenshots** is the default input; **Recording** retains the screen recorder and video import. Drop a new screenshot batch immediately. Optionally add your company domain, audience, job to be done, constraints, and differentiators under **More → Our product → Edit**. Connected imports analyze and organize automatically; restored or selected history batches do not re-upload. Analyze reruns a batch after context changes. Gemini connection setup stays under **More**, or **Research settings** in recordings; Analyze reveals it when a key is missing. Additional context, model/custom prompts, history, and the full editor remain available under **More**.

Screenshot batches accept up to 120 PNG/JPEG/WebP images, 8 MB each and 192 MB combined. The app copies them into its local library. Gemini reads resized images in groups of at most 24, then combines the findings into one brief for larger collections. Every retained screenshot receives its own analysis; no representative sampling silently discards screens. Exact duplicate images in a new import are skipped. Names and semantic groups apply to organized copies, preserving your original files. Unordered images do not establish click order, transitions, or task completion. Multiple visible products must remain distinct rather than become an imagined unified flow.

The default view shows the drop action, one compact brief and up to four group previews with names and counts. Groups describe visible product purpose, such as Onboarding or Billing, without implying flow order. Choose a group to browse its screens, or **Browse screens** for the collection. The source library opens only when needed, with 24 thumbnails per page. New imports generate small, rounded WebP previews for browsing; the evidence inspector retains the original image. Each screen has a short label and one-line purpose. Older batches without thumbnails remain readable. Search and group filters cover the entire collection; evidence navigation follows all matching or cited screens, including screens on other pages. Context, reanalysis, organized folders, exports and setup live under **More**. Importing a new collection resets the source browser to closed. A failed or cancelled analysis retains the imported images and any previous saved report; retry is explicit.

Timestamp links seek within the original source recording, independent of timeline cuts and zooms. New reports show up to four product pieces with their purpose and a source timestamp, inferred product/job, one strength, one friction point and one next action. Remaining pieces, findings, decisions, journey and unknowns expand when needed. Evidence opens the original recording on demand. Existing reports retain their saved findings until explicitly analyzed again. Markdown export uses consistent headings and includes context, evidence, confidence, unknowns, and report metadata for review alongside other exported reports. It excludes the custom system prompt and uses an explicit metadata allowlist; unmistakable Gemini keys and common local filesystem paths found in prose are marked `[redacted]`.

## Goals and journeys

The brief separates the end user's task from the research question. **What are you trying to learn?** is optional and stays under research settings. It guides which findings and experiment matter most; it does not become evidence. Existing tasks, briefs and custom prompts keep their exact wording. Without a supplied task, Gemini infers the visible goal and labels it inferred or unknown.

New reports show one compact goal and keep **Explore journey** or **Explore product pieces** closed. Expand to see each meaningful stage's purpose, its evidence, and the visible outcome or missing result. Recordings use chronological source timestamps and say whether the observed task is partial or complete; complete never means the entire product journey. Screenshot collections remain unordered product maps. Separate products stay distinct; missing onboarding, permission steps, activation or completion appear as gaps rather than invented screens. Every stage's citations are validated against the source. Older reports remain readable without automatic reanalysis.

The analysis looks for the user's trigger, prerequisites, first useful value, core work, feedback and result only where shown. It identifies supported constraints on the visible goal, weighs alternative explanations, and proposes a small test. Screens alone cannot establish a product's overall bottleneck, causal business impact or your company's unseen workflow. Application reasoning rules accompany the saved research lens without changing its wording.

## Capture and setup

On macOS, **Take screenshot** checks screen access only when pressed. If access is missing, a compact inline card opens the relevant System Settings pane and offers **Check access & capture** when you return. Import/drop works without capture permissions or an onboarding wizard. Returning from Settings checks access without capturing or uploading anything. macOS owns the grant; the app does not bypass it. A fresh native helper checks permission changes rather than relying on Electron's cached refusal.

The interactive macOS selector lets you choose a region or window. Product Intel hides during selection and returns afterwards; Escape preserves existing research. Temporary captures pass through the same validation, original-copy, thumbnail and automatic analysis pipeline as imports, then the temporary file is removed.

Recording setup shows source, Start and Cancel. Device, audio, cursor and decoration options stay collapsed; enabled microphone/camera/audio are identified in the disclosure. Hidden device previews do not activate until options open. The floating recorder also starts compact, with extra device and studio controls behind More. The research header stays in place; editor shortcuts and deferred editor prompts cannot expose or modify a hidden timeline. Capture returns to research. Startup opens research without the upstream permission onboarding page; any required recording permission appears only at capture time, with optional devices under More.

**Recording projects** under the app's More menu currently saves recording sources and reports. **Recent research** under screenshot More stores screenshot collections separately. They are not a unified research project or a cross-competitor library. Company/brief and default task settings are shared on this Mac. A future research container should hold both input types and its own context without adding required setup before capture.

## Data and limits

Analysis sends resized screenshots or the complete source recording, together with supplied context, to Google using the connected key and API quota. New screenshot imports analyze automatically when connected. Automatic recording analysis is optional and applies to newly captured and explicitly imported recordings. Restored reports never automatically upload again. Settings and reports are saved locally. The service attempts to delete the uploaded remote file after the request; the report records whether deletion was confirmed.

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
- [Google URL Context documentation](https://ai.google.dev/gemini-api/docs/generate-content/url-context)
- [Google generateContent API reference](https://ai.google.dev/api/generate-content)
- [Upstream OpenScreen repository, MIT license](https://github.com/getopenscreen/openscreen)
