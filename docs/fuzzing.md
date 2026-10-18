# OMNI fuzz and performance checks

## Parser and checker fuzzing

Run `npm run fuzz` to execute a deterministic 1,200-case token fuzzer and five adversarial size cases. These arbitrary token inputs are parsed and statically checked but never executed, so generated loops or file effects cannot run. Every outcome must be either a successful parse/check or a source-located `OmniDiagnostic`; host exceptions and stack failures fail the run. The fixed seed makes failures reproducible. Add a minimized failing source to the vocabulary or adversarial corpus before fixing it.

The same command also generates 256 bounded, effect-free integer and boolean expressions. It checks each expression, evaluates it in the interpreter, bytecode VM, and JavaScript engine, and compares every result with the generated expected value. This second corpus contains only literals, arithmetic, comparisons, and boolean operators; it cannot import files, call functions, loop, or perform I/O.

## Performance tracking

Run `npm run benchmark` to measure the maintained loop-and-function workload on the interpreter, bytecode VM, and JavaScript compiler. The JSON report records the workload hash, operating system, architecture, Node version, CPU model, compile median, execution median, and median absolute deviation. Keep reports from the same machine and toolchain together; never compare unlike environments.

To capture or compare a baseline:

    npm run benchmark > benchmarks/baselines/my-machine.json
    npm run benchmark -- --compare benchmarks/baselines/my-machine.json

The Windows x64 / Node 24 baseline in [`benchmarks/baselines/windows-x64-node24.json`](../benchmarks/baselines/windows-x64-node24.json) is a local reference for this workspace's Intel Core Ultra 5 225H. It is not a cross-machine performance claim. It was checked with a 50-sample, 10-warmup comparison; short runs can be noisy on a shared workstation. The comparison rejects mismatched environments or workload contents and treats a repeatable execution median increase of 10% or more as a regression investigation. Rerun the workload before attributing a change; correctness and conformance remain the release gates.
