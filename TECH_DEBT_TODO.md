# Tech Debt Todo

- [x] Add prompt-node variable resolution to runtime provider input rendering.
  The new Task snapshot renderer currently supports direct parent text/media inputs. Add support for prompt nodes with variable bindings so rendered provider inputs can be built from prompt templates and upstream task-run outputs without falling back to live graph execution.
- [x] Add output-reorder item-index mapping to runtime planning.
  The new Task Dependency model preserves edge addresses, but output reorder semantics still need explicit item-index remapping during planning so downstream tasks depend on the correct upstream branch indexes.
- [ ] Add final cost attribution for image and video provider execution.
  The new Vertex provider executor calculates LLM cost from usage, but image/video final cost is currently `0` until a reliable pricing source is wired into runtime settlement.
