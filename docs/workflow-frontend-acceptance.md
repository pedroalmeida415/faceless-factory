# Workflow Frontend Acceptance Suite

This suite defines frontend usability coverage for the node-based generative workflow after shared business rules and transport contracts are established. The frontend tests should mock server graph projections, execution projections, and SSE events; they should not implement or verify the server-owned runtime state machine itself.

## Core Stories

- Empty workflow with node palette.
- Prompt to Image Generation, single Branch, single Batch Item success.
- List(3) to Image Generation, 3 Branches, Single output mode carousel.
- List(3) plus Asset(1) to Image Generation, asset broadcast across 3 Branches.
- List(3) plus Asset(3) to Image Generation, zip by order.
- List(2) plus Asset(3) to Image Generation, Input Alignment blocked state.
- Image Generation repeatable image sockets: capacity 3, dynamic next socket behavior.
- Image Generation drawer config: model select, resolution select, Branch Batch Size.
- Branch Batch Size 4: per-Branch grid in Single mode.
- All output mode: masonry view across all Batch Items.
- Fullscreen output view from Single and All modes.
- Batch Item loading/error/success/retry states.
- Stale Result badge when committed graph/config differs from Run Snapshot fingerprint.
- Text Draft behavior: no downstream update until blur.
- Mock SSE event updates one Batch Item without rehydrating the entire graph projection.

## Projection And Loading

- Graph projection loads first, then execution projection hydrates onto known nodes.
- Empty, loading, and error states exist for graph projection and execution projection hydration.
- SSE ordering/race behavior: events for unknown or not-yet-hydrated execution state are safely ignored or queued.

## Validation And Authoring

- Required Prompt input missing: no Prompt connected, empty Prompt, blank-only List.
- Optional Image input with No Value: empty Asset connected is ignored for generation but still consumes socket capacity.
- Asset node zero, one, many assets with insertion order visibly preserved.
- List editor blank-row behavior: Add focuses first blank row before creating another.
- Branch Count max 50: exactly 50 valid, 51 blocked with clear validation.
- Edge type compatibility: text cannot connect to image input, image cannot connect to prompt input.
- Model change resets config to defaults.
- Model change lowering Input Capacity automatically drops excess Edges.
- Generation Cost display for Branch Count multiplied by Branch Batch Size.
- Rerun replaces current Result Set, with no run history UI.
- Stale detection is fingerprint-based after committed graph/config changes, not based on an exhaustive UI event trigger list.
- Autosave/revision behavior: material graph changes debounce into Graph Revision, while output display mode, focus, drawer visibility, and carousel state do not.
- Node focus opens config drawer for Generation Node; Input Nodes are edited inline on the canvas and do not open the drawer.
- Socket hover/focus accessibility: capacity label appears for keyboard focus, not only mouse hover.

## Out Of Scope For First Frontend Slice

- Mobile or narrow viewport behavior for canvas plus drawer/fullscreen output.

## Runtime-Owned Behavior

- Retrying a failed Batch Item uses the original Run Snapshot. Frontend stories may verify that retry actions are presented for failed Batch Items and that mocked projection updates are rendered, but the snapshot guarantee belongs to the server runtime.
- Debit, refund, insufficient-funds handling, durable state-machine transitions, and provider request behavior belong to the server runtime and should appear in frontend stories only as mocked projection states when needed.
