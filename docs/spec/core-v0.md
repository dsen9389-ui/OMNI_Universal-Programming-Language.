# OMNI Core Language Specification (core-v0)

This document specifies OMNI's implemented core language and is the source of truth for the interpreter. The language stays intentionally smaller than the eventual OMNI vision. Unsupported syntax is not implicitly reserved as a promise.

## Files and lexical rules

- Source files use the .om extension.
- A leading U+FEFF byte-order mark is ignored; U+FEFF elsewhere is not whitespace.
- Blocks use { and }. Semicolons are not used.
- ASCII space, horizontal tab, LF, CRLF, and CR separate tokens. Line endings have no parsing meaning; LF, CRLF, and CR each advance source locations by one line.
- # starts a comment that continues to the end of the line, including when the source uses LF, CRLF, or CR line endings.
- An identifier starts with a Unicode identifier-start character or _; later characters may be Unicode identifier-continue characters or _.
- Keywords: fn, let, var, return, if, else, while, for, in, break, continue, true, false, none, and, or, record, enum, match, import, as, extern.
- Numbers use ASCII decimal digits and may contain an exponent. An underscore may appear only between digits. A digit-only integer literal must be a JavaScript safe integer; fraction and exponent forms must produce a finite binary64 value.
- Strings use double quotes and support \\, \", \n, \r, \t, \{, and \} escapes.
- In strings, {name} substitutes the value of a simple identifier. {{ and }} produce literal braces. An unmatched single brace remains literal. Embedded expressions are not supported yet.

## Grammar

    program        := declaration*
    declaration    := record_decl | enum_decl | import_decl | function | external_function | statement
    record_decl    := "record" IDENT "{" (field_decl ("," field_decl)* ","?)? "}"
    field_decl     := IDENT ":" type
    enum_decl      := "enum" IDENT "{" (variant_decl ("," variant_decl)* ","?)? "}"
    variant_decl   := IDENT ("(" (type ("," type)* ","?)? ")")?
    import_decl    := "import" STRING "as" IDENT
    function       := "fn" IDENT "(" parameters? ")" ("->" type)? block
    external_function := "extern" "fn" IDENT "(" c_parameters? ")" ("->" type)?
    c_parameters   := c_parameter ("," c_parameter)* ","?
    c_parameter     := IDENT ":" type
    parameters     := parameter ("," parameter)* ","?
    parameter      := IDENT (":" type)?
    type           := type_path ("[" type ("," type)* ","? "]")? "?"?
    type_path      := IDENT ("." IDENT)*
    statement      := binding | match_stmt | "return" expression | "break" | "continue"
                    | "if" expression block ("else" (block | "if" expression block))?
                    | "while" expression block
                    | "for" IDENT "in" expression block
                    | block | expression
    match_stmt     := "match" expression "{" match_case+ "}"
    match_case     := pattern "=>" block
    pattern        := "_" | NUMBER | STRING | "true" | "false" | "none"
                    | type_path ("(" (pattern ("," pattern)* ","?)? ")")? | IDENT
    binding        := ("let" | "var") IDENT (":" type)? "=" expression
    block          := "{" declaration* "}"
    expression     := assignment
    assignment     := logical_or ("=" assignment)?
    logical_or     := logical_and ("or" logical_and)*
    logical_and    := equality ("and" equality)*
    equality       := ordering (("==" | "!=") ordering)*
    ordering       := additive (("<" | "<=" | ">" | ">=") additive)*
    additive       := multiplicative (("+" | "-") multiplicative)*
    multiplicative := unary (("*" | "/" | "%") unary)*
    unary          := ("!" | "-") unary | postfix
    postfix        := primary (call | index | member)*
    primary        := NUMBER | STRING | "true" | "false" | "none" | IDENT
                    | "(" expression ")" | "[" (expression ("," expression)* ","?)? "]"
    call           := "(" arguments? ")"
    arguments      := argument ("," argument)* ","?
    argument       := IDENT ":" expression | expression
    index          := "[" expression "]"
    member         := "." IDENT

The parser rejects assignment targets other than a variable, list index, or record field. Record and enum declarations, imports, and C ABI declarations are valid only at the top level. `extern fn` declares a direct native function symbol and does not contain a body. return is valid only inside a function; break and continue are valid only inside a loop. These context rules are not expressed in the grammar above. Record constructor calls use named arguments; ordinary function calls use positional arguments. Enum constructors use a qualified variant name and positional payloads. `=>` is the match-case separator; `->` introduces a function return type.

To keep errors source-located instead of exhausting the host stack, the parser limits recursive syntax nesting to 128 (E0101) and expression-tree depth to 128 (E1026). The expression-tree limit includes left-associative operator chains and is checked before static checking or engine traversal, so every engine receives a bounded tree. Ordinary arithmetic remains unchanged; this limit prevents a long flat expression from exhausting recursive compiler and checker implementations. See [the expression-depth example](../../examples/expression-depth.om) for the normal readable case.

## Static checking

The CLI parses and statically checks every project module before executing any program code. `omni check` performs these same steps without execution. Unknown names, duplicate declarations, invalid annotations, argument errors, and type mismatches therefore fail before a program can produce side effects.

Local bindings infer their type from the initializer unless an annotation is present. An empty list literal can take its element type from an explicit `List[T]` annotation. Function return types are inferred from their return statements unless an annotation is present. An unannotated function parameter has type Any, retaining a simple path for dynamic code; an annotation enables static argument and result checks. Any can be used where any type is expected, so operations involving Any may still fail their runtime checks. Built-in list, option, and result types take type arguments: List[T], Option[T], and Result[T, E]. T? is short for Option[T].

The checker follows source order and lexical block scopes. A function name is available in its own body for recursion. A record or enum name is available in its own field declarations, so self-recursive data types are supported. A name from a later declaration is not available early. Function parameters and local bindings can shadow outer names; duplicate names within one scope are errors. Record and enum type names share the declaration namespace with values. Built-in type names are reserved for type declarations.

## Implemented behavior

### Values

The runtime has numbers, text, booleans, lists, functions, records, enums, options, results, modules, and none. Numbers use IEEE-754 binary64. Integer literals must be safe integers; a Float annotation accepts any finite number, while Int accepts safe whole numbers. Numeric operations that produce a non-finite result fail at runtime.

Lists are mutable, zero-indexed, and may contain values of different kinds. List indices must be safe whole numbers within the current bounds; negative indices are invalid. Strings are immutable and index by Unicode code point. Text length and text iteration also count Unicode code points. Invalid indices produce a runtime diagnostic.

Records have named, mutable fields and are created with each field named exactly once, for example `Person(name: "Ada", age: 36)`. Field reads and updates use dot access. Record values have reference identity for equality. Enums declare at least one tagged variant; variants are qualified by their enum name, such as `LoadState.Ready("done")`. Variant payloads are positional and immutable. Enum values have reference identity for equality.

`none` is the empty option value and keeps its Phase 1 `Unit` behavior when used by itself. `some(value)` creates a populated Option. `ok(value)` and `err(value)` create the success and error cases of Result. Their payload types are checked statically where known. Pattern matching can inspect these cases without exposing their runtime representation.

### Variables and functions

let creates an immutable binding and var creates a mutable binding. Both require an initializer. Assignment can update only a var binding. Names share one namespace. A declaration may shadow a name from an outer scope, but duplicate names in the same scope are errors. A declaration checks its name and annotation before evaluating its initializer; the initializer runs before the new binding is installed. Bindings are introduced in source order and are not hoisted.

Each block creates a lexical scope. Functions declared with fn capture the scope where the declaration executes and resolve captured bindings when called, so changes to captured var bindings remain visible. Function declarations are introduced in source order and may be recursive. Duplicate parameter names are errors when the declaration executes. Arguments are evaluated before callability and arity are checked. Parameters are checked against annotations before the function body runs; a return annotation is checked after the function finishes. Without a return, a function returns none. return requires an expression.

Recognized built-in type annotations are Any, Number, Int, Float, Text, String, Bool, List, Option, Result, and Unit. String is an alias for Text. Number accepts any finite number; Float also accepts any finite number; Int accepts safe whole numbers. Any accepts every runtime value. List may omit its element argument, meaning List[Any], or take one argument; Option and Result require one and two arguments respectively. A trailing `?` accepts none and is shorthand for Option. User-defined record and enum types may also be used in annotations. Unknown types and incompatible annotations are compile-time errors; runtime checks remain as a safety net for Any values and embedded use. A typed list keeps its element contract when passed through Any: later `push` and indexed assignments must still match the declared element type, including for nested typed lists.

### Expressions and control flow

- Unary, multiplicative, additive, ordering, equality, and logical operators bind in that order from tightest to loosest. Binary operators at each level are left-associative; assignment is right-associative and binds more loosely than logical operators.
- Expressions evaluate operands from left to right. Calls evaluate the callee before arguments, and arguments and list elements evaluate in source order. and and or short-circuit.
- Assignment evaluates its destination before its value. Variable assignment resolves the binding and checks that it is mutable first. List-index assignment evaluates the list and index, checks the existing slot, evaluates the value, then checks the slot again before writing; an assignment cannot grow a list, even if its value expression changes that list.
- Assignment expressions evaluate to the value assigned.
- + adds two numbers or concatenates two text values. Other mixed-type arithmetic is an error. Numeric operations use binary64 arithmetic; % is remainder with the sign of the left operand. Operations that produce infinity or NaN fail.
- Ordered comparisons accept two numbers or two text values. Text ordering is lexicographic by UTF-16 code units and does not use locale rules. Equality compares primitive values by value and lists and functions by object identity; text equality compares the exact code-unit sequence without Unicode normalization.
- Conditions and logical operators require booleans; OMNI has no truthiness conversion.
- and and or short-circuit and return a boolean.
- A single expression tree is limited to 128 nested expressions (E1026); recursive calls start a fresh expression-depth count.
- At most 256 user-defined function calls may be active at once (E1017). Built-in calls do not count toward this limit.
- if, while, and for name in value require blocks. A while condition is evaluated before each iteration. A for iterable is evaluated once; it accepts a list or text and iterates in order. A list is shallow-copied when the loop starts, so appends and removals during the loop do not change the current iteration sequence. Text iteration visits Unicode code points.
- break and continue apply to the nearest enclosing loop.
- List indexing reads or writes an existing element; it does not grow a list.
- Record fields can be read and updated through dot access. Assignment evaluates the record and field before the assigned value. Module members and enum payloads cannot be assigned.
- A match value is evaluated once. Cases run in order, and the first matching case executes its block in a new scope. A case may bind payload values by name. `_` matches any remaining value. The checker rejects duplicate or unreachable cases and verifies exhaustive coverage for enums, Option, Result, Bool, and Unit; Number, Text, and Any matches need a final catch-all case. A payload-carrying enum variant or `some`, `ok`, and `err` case counts as fully covered only when each payload subpattern is `_` or a binding; more specific payload patterns may be combined but need a final catch-all if they do not cover all values.
- An import path is a literal relative `.om` file path resolved from the importing file. `import "./math.om" as math` binds a read-only module namespace named `math`. Every top-level declaration in the imported module is available through that namespace. Imports are loaded and executed once even when reached through multiple aliases; exported mutable bindings remain live through each alias. Dependencies execute before the importing module, and import cycles are rejected. Package names and global search paths are not supported.

### Built-ins

- print(value, ...) writes displayed values left to right, separated by one space, followed by a line feed. With no arguments it writes an empty line. It returns none.
- serial_write(text) writes the text's UTF-8 bytes to the embedded target's serial output, with no added line ending. It returns none and requires the embedded target's serial capability.
- gpio_write(pin, high) sets a digital output pin to high or low. pin must be an Int in the target's valid pin range; high must be Bool. It returns none and requires the embedded target's GPIO capability. A board adapter may reject pins that the selected board does not provide.
- len(text_or_list) returns a safe integer length: Unicode code points for text and elements for a list.
- str(value) returns its display form. none and booleans use `none`, `true`, and `false`. Numbers use the ECMAScript binary64 number-to-string format, with negative zero displayed as `0`. Lists use `[item, ...]`; if formatting reaches a list already on the current formatting path, that nested value is shown as `[...]` to mark the cycle. Functions display as `<fn name>`.
- type_of(value) returns Int for safe whole numbers, Float for other finite numbers, Text, Bool, List, Option, Result, Function, Unit, Module, or the declared name of a record or enum value.
- range(stop), range(start, stop), and range(start, stop, step) return integer lists. The default start is zero and the default step is one. The stop is exclusive. Arguments must be safe whole numbers, the step must be nonzero, and each range is limited to one million elements. A step that moves away from the stop produces an empty list.
- push(list, value) appends and returns the list length.
- pop(list) removes and returns the last element; an empty list is an error.
- some(value), ok(value), and err(value) construct Option and Result values.
- map(list, function) applies a one-argument function to a shallow snapshot of each list element in order and returns a new list of results.
- filter(list, predicate) applies a one-argument function to a shallow snapshot in order and returns a new list containing elements whose predicate result is true. A non-Bool result is an error.

## Execution engines and targets

OMNI source has one syntax across engines. The checker validates the complete module graph before execution. Each engine receives the same versioned semantic program: the checked parser tree, its source context, and the checked module interface. This tree is the shared high-level representation; expression and statement node kinds, operands, declarations, and source spans are explicit. Token trivia is not part of the representation. The initial representation version is 1.

The maintained engines are:

- `interpreter`: the reference tree-walking implementation, with the full implemented core described in this document.
- `bytecode`: a stack-based virtual machine for the portable core subset.
- `javascript`: compiles that same subset to generated JavaScript and runs it with Node.js.

The bytecode and JavaScript engines support bindings, functions and closures, arithmetic, booleans, text and simple interpolation, lists and indexing, assignment to mutable bindings and list elements, conditionals, loops, and the portable built-ins `print`, `len`, `str`, `type_of`, `range`, `push`, `pop`, `map`, `filter`, `some`, `ok`, and `err`. They support the built-in type annotations `Any`, `Number`, `Int`, `Float`, `Text`, `String`, `Bool`, `Unit`, `List`, `Option`, and `Result`, including `T?`.

The bytecode and JavaScript engines report E3002 at the source location for unsupported constructs. In this edition, that includes record and enum declarations, record/module member access, imports, and `match`. Select `interpreter` to run the full core. This support boundary is temporary and explicit; it does not introduce syntax differences between engines.

### Phase 4 targets and effects

OMNI has one canonical syntax and three built-in capability sets. Effects are inferred from calls to known built-ins; no effect annotations or target-specific syntax are needed. A target checks the complete entry module graph before any program code runs or a build is emitted. A direct call to an unavailable target API fails at that call with E3004. `serial_write` and `gpio_write` must be direct calls, not stored or passed as function values, so the checker can see their effects.

| Target | Capabilities | Output behavior | Execution/build path |
| --- | --- | --- | --- |
| `host` | `output` | `print` writes to the process output stream. | Interpreter supports the full core; bytecode and JavaScript support their portable Phase 3 subset. `omni run` uses this target. |
| `web` | `output` | `print` appends to the page's accessible output panel. | `omni build --target web` emits a static browser app using the JavaScript compiler and copied portable runtime. This target supports the JavaScript engine's Phase 3 subset and one source module; imports and unsupported engine constructs fail with E3002. |
| `embedded` | `output`, `serial`, `gpio` | `print` writes to serial with a line ending; `serial_write` writes exact text without adding one. | `omni build --target embedded` emits freestanding C plus a host simulator adapter and executable. Zig's C compiler builds the simulator on Linux and Windows; Apple Clang from Xcode Command Line Tools builds it on macOS. The generated firmware C depends only on standard freestanding headers and the small platform hooks in `omni_platform.h`. |

`serial_write(text)` and `gpio_write(pin, high)` are the target-specific APIs for the embedded platform boundary. They are recognized and type checked on every target, then rejected with E3004 when used outside `embedded`. `print` is the portable output API; each target connects its output effect to its normal output channel.

The embedded C backend accepts scalar `Int`, `Number`, `Float`, `Text`, `Bool`, and `Unit` values; simple bindings; top-level functions with typed parameters; arithmetic, boolean and comparison expressions; `if`, `while`, `return`, `break`, and `continue`; and direct calls to `print`, `serial_write`, `gpio_write`, and supported top-level functions. Function calls must be a whole statement, a binding initializer, an assignment value, or a returned value; calls nested inside other expressions or call arguments are not supported. Assignments inside arithmetic or comparison expressions are rejected to preserve OMNI's evaluation order; move the assignment to its own line first. The `and` and `or` operators retain their left-to-right short-circuit behavior. Its `print` implementation accepts Text and Bool values. It does not yet support heap collections, records, enums, imports, `for`, `match`, closures, function values, dynamic string interpolation or concatenation, remainder, or printing numeric values. Unsupported forms fail with a source-located E3002. These limits describe this backend only; the canonical language and host interpreter remain unchanged.

The included embedded simulator is a repeatable local target environment, not a claim that a physical board was tested. A board integration supplies the two platform hooks declared in `omni_platform.h`; the generated firmware C contains no operating-system I/O or allocator calls. The simulator adapter uses host standard I/O to show serial writes and GPIO state changes.

An `omni.toml` file may select a development engine, a release engine, and the host target:

    [run]
    profile = "core-v1"
    development = "interpreter"
    release = "javascript"
    target = "host"

The CLI searches from the entry file's directory toward its parent directories and uses the first `omni.toml` it finds. If none exists, the defaults above apply. `--mode development` is the default; `--mode release` selects the configured release engine. `--engine` overrides that choice. `--target` overrides the configured target. Phase 3 supports only `host`; unsupported targets fail with E3003. `omni check` checks the language and does not execute or select an engine.

Build target selection is separate from host execution. It can be passed on the command line or set in the same project file:

    [build]
    profile = "web-v1"
    target = "web"

`omni build app.om --target web` creates `build/web` next to the source file by default; `--out-dir` changes that location. `omni serve build/web` starts a localhost-only preview server. `omni build firmware.om --target embedded` creates `build/embedded`, including `firmware.c`, the platform header, a simulator adapter, and a native simulator executable. The embedded build needs Zig with `zig cc` on Linux and Windows, or Apple's Clang from Xcode Command Line Tools on macOS. Run the produced executable to observe the firmware demo in the simulator.

### Phase 5 profiles and C ABI v1

Profiles are named, versioned tuples, not independently combinable flags. The supported runtime, safety, standard-library, target, engine, and backend choices are listed in [the profile guide](../profiles.md) and mechanically mirrored by `conformance/profiles.json`. `[run] profile` and `[build] profile` choose profiles independently. A profile/target or profile/engine mismatch fails before source effects. A new incompatible tuple requires a new versioned profile identifier.

`extern fn name(parameter: Type, ...) -> ResultType` declares a C symbol whose name is exactly `name`. The result annotation may be omitted for a C `void` function. C ABI v1 is only available with `embedded-ffi-v1`; it accepts `Int`, `Float`, and `Bool` parameters and `Int`, `Float`, `Bool`, or `Unit` results. `Int` maps to `int32_t` and is checked for signed 32-bit range and whole-number value at each call; `Float` maps to `double`; `Bool` maps to C `bool`; an omitted result or `Unit` maps to `void`. Names must be ASCII portable C identifiers, cannot be C keywords or `main`, and cannot start with `omni_`.

C source files are supplied to `omni build` with repeatable `--c-source` options and linked into the local simulator. The user is responsible for implementing each declared symbol. Native code is trusted and unsandboxed. Text, pointers, records, callbacks, binary-library discovery, C ABI calls from the interpreter or other engines, and linking a physical board image are unsupported in this ABI version. An unavailable profile fails with E3002 before program effects.

The versioned pure-OMNI library modules in `stdlib/v1/` provide small scripting, web-response, game-rule, app-state, and data helpers. Their maintained examples live in `examples/domains/`. These modules use ordinary imports and do not add syntax or require a package registry. They are utility slices; a networking server, graphics engine, UI toolkit, and data-platform connectors remain future work.

For programs supported by multiple engines, the observable behavior specified by this document is the same. The maintained differential suite runs portable examples through the interpreter, bytecode VM, and JavaScript compiler and compares their output and result. Programs outside an engine's support boundary are rejected before execution.

## Diagnostics

Lexing, parsing, checking, import loading, and runtime failures report a stable error code, source path, one-based line and column, and a short message. Columns count Unicode code points; a tab counts as one column. The source excerpt replaces tabs with one space so its caret aligns with that logical column. LF, CRLF, and CR each advance the line once. The CLI does not print internal stack traces for expected language errors.

The diagnostic codes are part of the core contract; message wording may be clarified without changing a code's meaning.

| Code | Meaning |
| --- | --- |
| E0001 | Unexpected source character |
| E0002 | Invalid or out-of-range numeric literal |
| E0003 | Invalid, incomplete, or unterminated string literal |
| E0101 | Syntax error |
| E1001 | Unknown name |
| E1002 | Duplicate declaration or parameter in one scope |
| E1003 | Assignment to an immutable binding |
| E1010 | Invalid argument to `len` |
| E1011 | Invalid `range` arguments or range limit exceeded |
| E1012 | Invalid `push` or `pop` operation |
| E1013 | Invalid value for `for` iteration |
| E1014 | Invalid ordered comparison |
| E1015 | Attempt to call a non-function value |
| E1016 | Incorrect function argument count |
| E1017 | The limit of 256 active user-defined function calls is exceeded |
| E1018 | Unsupported string interpolation form |
| E1020 | Unsupported runtime type annotation |
| E1021 | Runtime type annotation mismatch |
| E1022 | Condition or logical operand is not Bool |
| E1023 | Arithmetic operand is not a finite number |
| E1024 | Numeric operation produced a non-finite result |
| E1025 | Invalid index or indexed assignment |
| E1026 | The limit of 128 nested expressions in a tree is exceeded |
| E2001 | Unknown name or type found by static checking |
| E2002 | Duplicate or reserved declaration name found by static checking |
| E2003 | Static type mismatch |
| E2004 | Invalid function or constructor call |
| E2005 | Unknown or invalid member access |
| E2006 | Invalid record construction or field update |
| E2007 | Invalid pattern or pattern payload |
| E2008 | Match is not exhaustive |
| E2050 | Imported module cannot be found or read |
| E2051 | Import cycle |
| E3001 | Invalid project execution configuration or configured engine |
| E3002 | Program construct is outside an engine's supported subset |
| E3003 | Target is not supported by the requested command |
| E3004 | Target lacks a required effect capability or API is used indirectly |
| E3005 | Required target compiler is missing or a target build failed |

## Explicitly not specified yet

General-purpose generics, type aliases, async, exceptions, memory ownership, configurable effect declarations, versioned profile compatibility, broader web and embedded support, and a production native machine-code engine require future specification work.
