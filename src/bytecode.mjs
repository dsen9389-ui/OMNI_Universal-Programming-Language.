import { validatePortableProgram } from "./portable-compiler.mjs";

export class BytecodeCompiler {
    constructor(program, context) {
        this.program = program;
        this.context = context;
        this.chunks = [{ name: "<main>", parameters: [], returnType: null, bodySpan: null, instructions: [] }];
        this.currentChunk = 0;
        this.scopeDepth = 0;
        this.loopStack = [];
        this.nextIterator = 0;
    }

    compile() {
        for (const statement of this.program.declarations) {
            this.emitStatement(statement);
            this.emit("SET_RESULT");
        }
        this.emit("HALT");
        return this.chunks;
    }

    emit(op, fields = {}) {
        const instruction = { op, ...fields };
        this.chunks[this.currentChunk].instructions.push(instruction);
        return instruction;
    }

    patch(instruction, field, value) {
        instruction[field] = value;
    }

    get instructions() {
        return this.chunks[this.currentChunk].instructions;
    }

    emitStatement(statement) {
        switch (statement.kind) {
            case "BindingDeclaration":
                this.emitExpression(statement.initializer);
                this.emit("DEFINE", {
                    name: statement.name,
                    mutable: statement.mutable,
                    annotation: statement.typeAnnotation,
                    span: statement.span,
                });
                return;
            case "FunctionDeclaration":
                this.emitFunction(statement);
                return;
            case "BlockStatement":
                this.emit("ENTER_SCOPE");
                this.scopeDepth += 1;
                for (const declaration of statement.declarations) {
                    this.emitStatement(declaration);
                    this.emit("POP");
                }
                this.scopeDepth -= 1;
                this.emit("EXIT_SCOPE");
                this.emit("CONST", { value: null });
                return;
            case "ExpressionStatement":
                this.emitExpression(statement.expression);
                return;
            case "IfStatement": {
                this.emitExpression(statement.condition);
                this.emit("CHECK_BOOL", { span: statement.condition.span });
                const jumpToElse = this.emit("JUMP_IF_FALSE", { target: null });
                this.emitStatement(statement.thenBranch);
                this.emit("POP");
                const jumpToEnd = this.emit("JUMP", { target: null, scopeDepth: this.scopeDepth });
                this.patch(jumpToElse, "target", this.instructions.length);
                if (statement.elseBranch) {
                    this.emitStatement(statement.elseBranch);
                    this.emit("POP");
                }
                this.patch(jumpToEnd, "target", this.instructions.length);
                this.emit("CONST", { value: null });
                return;
            }
            case "WhileStatement":
                this.emitWhile(statement);
                return;
            case "ForStatement":
                this.emitFor(statement);
                return;
            case "ReturnStatement":
                this.emitExpression(statement.value);
                this.emit("RETURN");
                return;
            case "BreakStatement":
                this.emitLoopJump("break");
                return;
            case "ContinueStatement":
                this.emitLoopJump("continue");
                return;
            default:
                throw new Error("validated bytecode statement was not compiled: " + statement.kind);
        }
    }

    emitWhile(statement) {
        const start = this.instructions.length;
        this.emitExpression(statement.condition);
        this.emit("CHECK_BOOL", { span: statement.condition.span });
        const end = this.emit("JUMP_IF_FALSE", { target: null });
        const loop = { breaks: [], continueTarget: start, scopeDepth: this.scopeDepth };
        this.loopStack.push(loop);
        this.emitStatement(statement.body);
        this.emit("POP");
        this.emit("JUMP", { target: start, scopeDepth: this.scopeDepth });
        this.loopStack.pop();
        const target = this.instructions.length;
        this.patch(end, "target", target);
        for (const jump of loop.breaks) this.patch(jump, "target", target);
        this.emit("CONST", { value: null });
    }

    emitFor(statement) {
        const iterator = this.nextIterator++;
        this.emitExpression(statement.iterable);
        this.emit("ITER_START", { iterator, span: statement.iterable.span });
        const loopStart = this.instructions.length;
        const next = this.emit("ITER_NEXT", { iterator, name: statement.name, span: statement.span, target: null });
        const baseScopeDepth = this.scopeDepth;
        this.scopeDepth += 1;
        const loop = { breaks: [], continueTarget: loopStart, scopeDepth: baseScopeDepth };
        this.loopStack.push(loop);
        this.emitStatement(statement.body);
        this.emit("POP");
        this.emit("EXIT_SCOPE");
        this.scopeDepth -= 1;
        this.emit("JUMP", { target: loopStart, scopeDepth: this.scopeDepth });
        this.loopStack.pop();
        const target = this.instructions.length;
        this.patch(next, "target", target);
        for (const jump of loop.breaks) this.patch(jump, "target", target);
        this.emit("CONST", { value: null });
    }

    emitLoopJump(kind) {
        const loop = this.loopStack.at(-1);
        if (!loop) throw new Error("loop control reached bytecode compiler without a loop");
        const jump = this.emit("UNWIND_JUMP", {
            target: kind === "break" ? null : loop.continueTarget,
            scopeDepth: loop.scopeDepth,
        });
        if (kind === "break") loop.breaks.push(jump);
    }

    emitFunction(declaration) {
        const index = this.chunks.length;
        this.chunks.push({
            name: declaration.name,
            parameters: declaration.parameters,
            returnType: declaration.returnType,
            bodySpan: declaration.body.span,
            instructions: [],
        });
        const savedChunk = this.currentChunk;
        const savedScopeDepth = this.scopeDepth;
        const savedLoopStack = this.loopStack;
        this.currentChunk = index;
        this.scopeDepth = 0;
        this.loopStack = [];
        this.emitStatement(declaration.body);
        this.emit("RETURN");
        this.currentChunk = savedChunk;
        this.scopeDepth = savedScopeDepth;
        this.loopStack = savedLoopStack;
        this.emit("DEFINE_FUNCTION", { chunk: index, declaration, span: declaration.span });
        this.emit("CONST", { value: null });
    }

    emitExpression(expression) {
        this.emit("EXPR_ENTER", { span: expression.span });
        switch (expression.kind) {
            case "LiteralExpression":
                if (expression.literalType === "text") {
                    this.emit("INTERPOLATE", { template: expression.value, span: expression.span });
                } else {
                    this.emit("CONST", { value: expression.value });
                }
                break;
            case "IdentifierExpression":
                this.emit("LOAD", { name: expression.name, span: expression.span });
                break;
            case "ListExpression":
                for (const element of expression.elements) this.emitExpression(element);
                this.emit("MAKE_LIST", { count: expression.elements.length });
                break;
            case "UnaryExpression":
                this.emitExpression(expression.operand);
                this.emit("UNARY", {
                    operator: expression.operator,
                    operandSpan: expression.operand.span,
                    span: expression.span,
                });
                break;
            case "BinaryExpression":
                if (expression.operator === "and" || expression.operator === "or") {
                    this.emitLogical(expression);
                } else {
                    this.emitExpression(expression.left);
                    this.emitExpression(expression.right);
                    this.emit("BINARY", {
                        operator: expression.operator,
                        leftSpan: expression.left.span,
                        rightSpan: expression.right.span,
                        span: expression.span,
                    });
                }
                break;
            case "AssignmentExpression":
                this.emitAssignment(expression);
                break;
            case "CallExpression":
                this.emitExpression(expression.callee);
                for (const argument of expression.arguments) this.emitExpression(argument);
                this.emit("CALL", {
                    count: expression.arguments.length,
                    span: expression.span,
                    calleeSpan: expression.callee.span,
                });
                break;
            case "IndexExpression":
                this.emitExpression(expression.object);
                this.emitExpression(expression.index);
                this.emit("GET_INDEX", { span: expression.span });
                break;
            default:
                throw new Error("validated bytecode expression was not compiled: " + expression.kind);
        }
        this.emit("EXPR_EXIT");
    }

    emitLogical(expression) {
        this.emitExpression(expression.left);
        this.emit("CHECK_BOOL", { span: expression.left.span });
        this.emit("DUP");
        const jump = this.emit(expression.operator === "and" ? "JUMP_IF_FALSE" : "JUMP_IF_TRUE", { target: null });
        this.emit("POP");
        this.emitExpression(expression.right);
        this.emit("CHECK_BOOL", { span: expression.right.span });
        this.patch(jump, "target", this.instructions.length);
    }

    emitAssignment(expression) {
        if (expression.target.kind === "IdentifierExpression") {
            this.emit("PREPARE_ASSIGN", { name: expression.target.name, span: expression.target.span });
            this.emitExpression(expression.value);
            this.emit("STORE_ASSIGN", { span: expression.target.span });
            return;
        }
        this.emitExpression(expression.target.object);
        this.emitExpression(expression.target.index);
        this.emit("PREPARE_INDEX_ASSIGN", { span: expression.target.span });
        this.emitExpression(expression.value);
        this.emit("STORE_INDEX", { span: expression.target.span });
    }
}

export function compileBytecode(program, context) {
    validatePortableProgram(program, context, "bytecode");
    return new BytecodeCompiler(program, context).compile();
}
