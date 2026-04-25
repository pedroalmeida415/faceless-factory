# UI/UX

- [X] ~~When dragging and releasing any edge, display an autocomplete popup to select what node to connect the edge to (bunx --bun shadcn@latest add @coss/autocomplete). Both for input and output sockets.~~
- [X] ~~Node config drawer upon selection (instead of displaying all options in the node itself, display only minimal relevant info, tuck configs away into a drawer that opens automatically on node selection)~~
- [X] ~~Uploaded & generated assets visualizer with drag and drop to asset node~~
- [X] ~~UI for user credits~~
- [X] ~~Display socket type name on output sockets too, not just input.~~
- [X] ~~Display Prompt/text node as option for text input in the node suggestion autocomplete when dragging an edge and releasing outside a socket. Make it so the text node spawns with a variable, and then the edge is connected to that variable.~~
- [ ] Create iterator combination visualizer to show all combinations that are about to be run, clearing any confusion
- [ ] Left-click selection box (select multiple nodes at once, default normal arrow cursor, grab cursor only on middle-click/node hover for drag)
- [ ] Improve nodes design
- [ ] Output visualization toggle (focused 1 at a time carousel/gallery grid list)
- [ ] Generation state feedback
- [ ] Add support for structured outputs on LLM node
- [ ] Support pasting images
- [ ] Support drag/drop images


# Application
- [X] ~~Database design (tables, credits, etc...)~~
- [X] ~~Plans Stripe integration~~
- [ ] Any LLM node for text-related functionality.
- [ ] Extract a provider-agnostic LLM model registry so adding OpenAI/Anthropic models only requires pricing + estimate config + execution adapter wiring.
- [ ] Human-in-the-loop nodes or something to that require approval before moving forward.

# Infra
- [ ] How to deploy to prod?
- [ ] Posthog analytics
- [ ] Observabilty

# Testing
- [ ] tests tests tests, integration, E2E?
