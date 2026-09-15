# PoE2 tree search: scope, timing and timeouts

## Measured reference

Epicurus's private timing run, reported by the parent on 2026-09-16, completed
24 native calculation calls in 33.6 seconds: median 1.36 seconds per call and
peak memory 659 MiB. This is a reference for that workload; other builds and
configurations can take longer or use more memory. No maximum-size stress run
was performed for this documentation.

Core MCP acceptance on the owned API 1.4 runtime completed on 2026-09-16.
The default `optimize_tree` call took **54.58 seconds**, including 34 native
calculations: two weapon-set baselines, four refund alternatives in both sets,
and 12 candidate scenarios in both sets. Across that call, a zero-point
attribute suggestion, three passive upgrade alternatives, and invalid-ID
rejection, all **56 native calculations** returned the requested weapon set and
tree version. Their median duration was 1.24 seconds. Before/after XML, build
identity, tree, stats and config were unchanged after every workflow.

The default damage search found no strict improvement in its bounded scope and
returned no optimization proposal. It reported the remaining unassessed scope;
this acceptance result is not evidence of a global optimum. Maximum-size and
five-iteration native searches remain untested.

## What the search limits count

- `max_candidates` defaults to 12 and caps **candidate scenarios per iteration**,
  across all removal alternatives. Each attribute-choice variant consumes a
  scenario. A rejected scenario also consumes its allowance if calculation began.
- Each scenario uses up to two native calls, one per weapon set. There are two
  baseline calls for the search.
- Automatic refund search additionally examines at most four legal leaves per
  iteration, using up to eight native calls. It retains two measured refund
  alternatives. These calls are outside `max_candidates`.
- `max_iterations` defaults to 1 and permits at most 5 optimization iterations.
  `suggest_optimal_nodes` uses one iteration. `get_passive_upgrades` can examine
  refund alternatives, so its call allowance includes the refund search.
- `max_distance` defaults to 3; paths beyond this bound are outside the search.
  Missing attribute choices use three uniform path assignments, rather than
  enumerating every mixed assignment. Explicit choices can specify a mixed path.
- Results describe bounded alternatives. They do not establish a global optimum.
  The result reports candidate-limit cutoffs separately from rejected proposals.
  Unvisited targets, untested attribute variants and skipped removal alternatives
  remain unassessed, not invalid or zero-value.

## Planning a timeout

An upper bound on native calculation calls is:

`2 + iterations × (2 × max_candidates + automatic_refund_calls)`

Here `automatic_refund_calls` is at most 8, or 0 when automatic refunds are off.
Early exits and rejected scenarios can reduce the actual count. XML, identity,
graph and other work also take time.

| Search | Native call bound | Rough calculation time at the sample mean of 1.4 s/call | Suggested overall MCP timeout |
|---|---:|---:|---:|
| 12 candidates, 1 iteration, no automatic refunds | 26 | 36 s | 120 s |
| 12 candidates, 1 iteration, automatic refunds | 34 | 48 s | 120 s |
| 40 candidates, 5 iterations, no automatic refunds | 402 | 563 s (9.4 min) | 900 s |
| 40 candidates, 5 iterations, automatic refunds | 442 | 619 s (10.3 min) | 900 s |

These times are extrapolations, not upper bounds. Start with the defaults for
native acceptance checks. For a larger explicit search, increase the client's
overall tool timeout before running, or reduce the search limits. The project
uses `tool_timeout_sec` for the overall MCP timeout; `POB_TIMEOUT_MS` controls
individual native requests and is a separate limit.

There is no automatic wall-clock cutoff in this change. A client timeout does
not produce a completed, preservation-verified proposal. Do not treat an
interrupted run as a fully evaluated search. Every calculation still carries
the expected build name/XML guards, and successful responses retain the final
XML/stat preservation check.
