# UI/UX

- [ ] Create iterator combination visualizer to show all combinations that are about to be run, clearing any confusion
- [ ] When dragging and releasing any edge, display an autocomplete popup to select what node to connect the edge to (bunx --bun shadcn@latest add @coss/autocomplete). Both for input and output sockets.
- [ ] Display socket type name on output sockets too, not just input.
- [ ] Improve nodes design
- [ ] Node config drawer upon selection (instead of displaying all options in the node itself, display only minimal relevant info, tuck configs away into a drawer that opens automatically on node selection)
- [ ] Output visualization toggle (focused 1 at a time carousel/gallery grid list)
- [ ] Uploaded & generated assets visualizer with drag and drop to asset node
- [ ] Left-click selection box (select multiple nodes at once, default normal arrow cursor, grab cursor only on middle-click/node hover for drag)
- [X] ~~UI for user credits~~
- [ ] Generation state feedback


# Application
- [X] ~~Database design (tables, credits, etc...)~~
- [ ] Any LLM node for text-related functionality.
- [ ] Human-in-the-loop nodes or something to  that require approval before moving forward.
- [ ] Plans Stripe integration

# Infra
- [ ] How to deploy to prod?
- [ ] Posthog analytics
- [ ] Observabilty

# Testing
- [ ] tests tests tests, integration, E2E?