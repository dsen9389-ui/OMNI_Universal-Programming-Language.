import { fail } from "./diagnostics.mjs";

const reservedWords = new Set([
    "fn", "let", "var", "return", "if", "else", "while", "for", "in",
    "break", "continue", "true", "false", "none", "and", "or", "record", "enum",
    "match", "import", "as", "extern",
]);
const MAX_PARSER_NESTING = 128;
const MAX_EXPRESSION_NESTING = 128;
const expressionKinds = new Set([
    "AssignmentExpression", "BinaryExpression", "CallExpression", "IdentifierExpression",
    "IndexExpression", "ListExpression", "LiteralExpression", "MemberExpression", "UnaryExpression",
]);

export class Parser {
    constructor(tokens, source, sourceName) {
        this.tokens = tokens;
        this.source = source;
        this.sourceName = sourceName;
        this.current = 0;
        this.functionDepth = 0;
        this.loopDepth = 0;
        this.nestingDepth = 0;
    }

    parse() {
        const declarations = [];
        while (!this.isAtEnd()) declarations.push(this.parseDeclaration(true));
        const program = { kind: "Program", declarations };
        this.checkExpressionTreeDepth(program);
        return program;
    }

    checkExpressionTreeDepth(program) {
        const pending = [{ node: program, depth: 0 }];
        while (pending.length > 0) {
            const { node, depth: parentDepth } = pending.pop();
            if (!node || typeof node !== "object") continue;
            const depth = expressionKinds.has(node.kind) ? parentDepth + 1 : parentDepth;
            if (depth > MAX_EXPRESSION_NESTING) {
                this.errorAtSpan(node.span, "E1026", "expression nesting exceeds the limit of " + MAX_EXPRESSION_NESTING);
            }
            for (const [key, value] of Object.entries(node)) {
                if (key === "span" || value === null || typeof value !== "object") continue;
                if (Array.isArray(value)) {
                    for (const child of value) pending.push({ node: child, depth });
                } else {
                    pending.push({ node: value, depth });
                }
            }
        }
    }

    parseDeclaration(topLevel = false) {
        if (this.matchKeyword("record")) {
            if (!topLevel) this.error(this.previous(), "record declarations are only allowed at the top level");
            return this.parseRecord(this.previous());
        }
        if (this.matchKeyword("enum")) {
            if (!topLevel) this.error(this.previous(), "enum declarations are only allowed at the top level");
            return this.parseEnum(this.previous());
        }
        if (this.matchKeyword("import")) {
            if (!topLevel) this.error(this.previous(), "imports are only allowed at the top level");
            return this.parseImport(this.previous());
        }
        if (this.matchKeyword("extern")) {
            if (!topLevel) this.error(this.previous(), "C ABI declarations are only allowed at the top level");
            const start = this.previous();
            if (!this.matchKeyword("fn")) this.error(this.peek(), "expected 'fn' after 'extern'");
            return this.parseExternalFunction(start);
        }
        if (this.matchKeyword("fn")) return this.parseFunction(this.previous());
        return this.parseStatement();
    }

    parseRecord(startToken) {
        const name = this.expectIdentifier("expected a record name");
        this.expect("{", "expected '{' after the record name");
        const fields = [];
        while (!this.check("}") && !this.isAtEnd()) {
            const field = this.expectIdentifier("expected a record field name");
            this.expect(":", "expected ':' after the record field name");
            const typeAnnotation = this.parseType();
            fields.push({ name: field.value, nameSpan: field.span, typeAnnotation, span: field.span });
            if (!this.match(",") && !this.check("}")) this.error(this.peek(), "expected ',' between record fields");
        }
        const close = this.expect("}", "expected '}' to close this record");
        return {
            kind: "RecordDeclaration",
            name: name.value,
            nameSpan: name.span,
            fields,
            span: joinSpan(startToken.span, close.span),
        };
    }

    parseEnum(startToken) {
        const name = this.expectIdentifier("expected an enum name");
        this.expect("{", "expected '{' after the enum name");
        const variants = [];
        while (!this.check("}") && !this.isAtEnd()) {
            const variant = this.expectIdentifier("expected an enum variant name");
            const fields = [];
            if (this.match("(")) {
                if (!this.check(")")) {
                    do {
                        fields.push(this.parseType());
                    } while (this.match(",") && !this.check(")"));
                    this.match(",");
                }
                this.expect(")", "expected ')' after enum variant fields");
            }
            variants.push({ name: variant.value, nameSpan: variant.span, fields, span: variant.span });
            if (!this.match(",") && !this.check("}")) this.error(this.peek(), "expected ',' between enum variants");
        }
        const close = this.expect("}", "expected '}' to close this enum");
        return {
            kind: "EnumDeclaration",
            name: name.value,
            nameSpan: name.span,
            variants,
            span: joinSpan(startToken.span, close.span),
        };
    }

    parseImport(startToken) {
        const path = this.expectKind("string", "expected a quoted relative module path");
        if (!this.matchKeyword("as")) this.error(this.peek(), "expected 'as' and a module name after the path");
        const alias = this.expectIdentifier("expected a module name after 'as'");
        return {
            kind: "ImportDeclaration",
            path: path.value,
            alias: alias.value,
            nameSpan: alias.span,
            span: joinSpan(startToken.span, alias.span),
            pathSpan: path.span,
        };
    }

    parseFunction(startToken) {
        const name = this.expectIdentifier("expected a function name");
        this.expect("(", "expected '(' after the function name");
        const parameters = [];
        if (!this.check(")")) {
            do {
                const parameter = this.expectIdentifier("expected a parameter name");
                let typeAnnotation = null;
                if (this.match(":")) typeAnnotation = this.parseType();
                parameters.push({
                    name: parameter.value,
                    nameSpan: parameter.span,
                    typeAnnotation,
                    span: parameter.span,
                });
            } while (this.match(",") && !this.check(")"));
            this.match(",");
        }
        this.expect(")", "expected ')' after function parameters");

        let returnType = null;
        if (this.match("->")) returnType = this.parseType();

        const savedLoopDepth = this.loopDepth;
        this.loopDepth = 0;
        this.functionDepth += 1;
        let body;
        try {
            body = this.parseBlock("expected a block after the function signature");
        } finally {
            this.functionDepth -= 1;
            this.loopDepth = savedLoopDepth;
        }

        return {
            kind: "FunctionDeclaration",
            name: name.value,
            nameSpan: name.span,
            parameters,
            returnType,
            body,
            span: joinSpan(startToken.span, body.span),
        };
    }

    parseExternalFunction(startToken) {
        const name = this.expectIdentifier("expected a C function name");
        this.expect("(", "expected '(' after the C function name");
        const parameters = [];
        if (!this.check(")")) {
            do {
                const parameter = this.expectIdentifier("expected a parameter name");
                this.expect(":", "C ABI parameters need an explicit scalar type");
                const typeAnnotation = this.parseType();
                parameters.push({ name: parameter.value, nameSpan: parameter.span, typeAnnotation, span: parameter.span });
            } while (this.match(",") && !this.check(")"));
            this.match(",");
        }
        const close = this.expect(")", "expected ')' after C function parameters");
        let returnType = null;
        if (this.match("->")) returnType = this.parseType();
        const end = returnType?.span ?? close.span;
        return {
            kind: "ExternalFunctionDeclaration",
            name: name.value,
            nameSpan: name.span,
            parameters,
            returnType,
            span: joinSpan(startToken.span, end),
        };
    }

    parseStatement() {
        if (this.matchKeyword("let", "var")) return this.parseBinding(this.previous());
        if (this.matchKeyword("if")) return this.parseIf(this.previous());
        if (this.matchKeyword("while")) return this.parseWhile(this.previous());
        if (this.matchKeyword("for")) return this.parseFor(this.previous());
        if (this.matchKeyword("match")) return this.parseMatch(this.previous());
        if (this.matchKeyword("return")) return this.parseReturn(this.previous());
        if (this.matchKeyword("break")) {
            const token = this.previous();
            if (this.loopDepth === 0) this.error(token, "break can only be used inside a loop");
            return { kind: "BreakStatement", span: token.span };
        }
        if (this.matchKeyword("continue")) {
            const token = this.previous();
            if (this.loopDepth === 0) this.error(token, "continue can only be used inside a loop");
            return { kind: "ContinueStatement", span: token.span };
        }
        if (this.match("{")) return this.parseBlockAfterOpen(this.previous());

        const expression = this.parseExpression();
        return { kind: "ExpressionStatement", expression, span: expression.span };
    }

    parseBinding(keyword) {
        const name = this.expectIdentifier("expected a binding name");
        let typeAnnotation = null;
        if (this.match(":")) typeAnnotation = this.parseType();
        this.expect("=", "expected '=' and an initial value for this binding");
        const initializer = this.parseExpression();
        return {
            kind: "BindingDeclaration",
            name: name.value,
            nameSpan: name.span,
            mutable: keyword.value === "var",
            typeAnnotation,
            initializer,
            span: joinSpan(keyword.span, initializer.span),
        };
    }

    parseIf(startToken) {
        return this.withNesting(startToken, () => {
            const condition = this.parseExpression();
            const thenBranch = this.parseBlock("expected a block after the if condition");
            let elseBranch = null;
            if (this.matchKeyword("else")) {
                if (this.matchKeyword("if")) {
                    elseBranch = this.parseIf(this.previous());
                } else {
                    elseBranch = this.parseBlock("expected a block after else");
                }
            }
            return {
                kind: "IfStatement",
                condition,
                thenBranch,
                elseBranch,
                span: joinSpan(startToken.span, (elseBranch ?? thenBranch).span),
            };
        });
    }

    parseWhile(startToken) {
        const condition = this.parseExpression();
        this.loopDepth += 1;
        let body;
        try {
            body = this.parseBlock("expected a block after the while condition");
        } finally {
            this.loopDepth -= 1;
        }
        return { kind: "WhileStatement", condition, body, span: joinSpan(startToken.span, body.span) };
    }

    parseFor(startToken) {
        const name = this.expectIdentifier("expected a loop variable after for");
        if (!this.matchKeyword("in")) this.error(this.peek(), "expected 'in' after the loop variable");
        const iterable = this.parseExpression();
        this.loopDepth += 1;
        let body;
        try {
            body = this.parseBlock("expected a block after the for expression");
        } finally {
            this.loopDepth -= 1;
        }
        return {
            kind: "ForStatement",
            name: name.value,
            iterable,
            body,
            span: joinSpan(startToken.span, body.span),
        };
    }

    parseReturn(startToken) {
        if (this.functionDepth === 0) this.error(startToken, "return can only be used inside a function");
        if (this.check("}") || this.isAtEnd()) this.error(startToken, "return needs a value in this edition");
        const value = this.parseExpression();
        return { kind: "ReturnStatement", value, span: joinSpan(startToken.span, value.span) };
    }

    parseMatch(startToken) {
        return this.withNesting(startToken, () => {
            const value = this.parseExpression();
            this.expect("{", "expected '{' before match cases");
            const cases = [];
            while (!this.check("}") && !this.isAtEnd()) {
                const pattern = this.parsePattern();
                this.expect("=>", "expected '=>' after a match pattern");
                const body = this.parseBlock("expected a block after a match pattern");
                cases.push({ pattern, body, span: joinSpan(pattern.span, body.span) });
            }
            const close = this.expect("}", "expected '}' to close this match");
            if (cases.length === 0) this.error(close, "match needs at least one case");
            return {
                kind: "MatchStatement",
                value,
                cases,
                span: joinSpan(startToken.span, close.span),
            };
        });
    }

    parsePattern() {
        return this.withNesting(this.peek(), () => {
            if (this.matchKind("number")) return { kind: "NumberPattern", value: this.previous().value, span: this.previous().span };
            if (this.matchKind("string")) return { kind: "TextPattern", value: this.previous().value, span: this.previous().span };
            if (this.matchKeyword("true")) return { kind: "BoolPattern", value: true, span: this.previous().span };
            if (this.matchKeyword("false")) return { kind: "BoolPattern", value: false, span: this.previous().span };
            if (this.matchKeyword("none")) return { kind: "NonePattern", span: this.previous().span };
            if (!this.checkKind("identifier")) this.error(this.peek(), "expected a match pattern");

            const first = this.advance();
            if (first.value === "_") return { kind: "WildcardPattern", span: first.span };
            const path = [first.value];
            while (this.match(".")) path.push(this.expectIdentifier("expected a name after '.' in this pattern").value);

            if (this.match("(")) {
                const fields = [];
                if (!this.check(")")) {
                    do {
                        fields.push(this.parsePattern());
                    } while (this.match(",") && !this.check(")"));
                    this.match(",");
                }
                const close = this.expect(")", "expected ')' after pattern values");
                return {
                    kind: "ConstructorPattern",
                    path,
                    fields,
                    span: joinSpan(first.span, close.span),
                };
            }

            if (path.length > 1) {
                return { kind: "EnumVariantPattern", path, span: joinSpan(first.span, this.previous().span) };
            }
            return { kind: "BindingPattern", name: first.value, nameSpan: first.span, span: first.span };
        });
    }

    parseBlock(message) {
        this.expect("{", message);
        return this.parseBlockAfterOpen(this.previous());
    }

    parseBlockAfterOpen(openToken) {
        return this.withNesting(openToken, () => {
            const declarations = [];
            while (!this.check("}") && !this.isAtEnd()) declarations.push(this.parseDeclaration());
            const closeToken = this.expect("}", "expected '}' to close this block");
            return {
                kind: "BlockStatement",
                declarations,
                span: joinSpan(openToken.span, closeToken.span),
            };
        });
    }

    parseType() {
        return this.withNesting(this.peek(), () => {
            const first = this.expectIdentifier("expected a type name");
            const path = [first.value];
            let last = first;
            while (this.match(".")) {
                last = this.expectIdentifier("expected a type name after '.'");
                path.push(last.value);
            }
            const argumentsList = [];
            if (this.match("[")) {
                if (!this.check("]")) {
                    do {
                        argumentsList.push(this.parseType());
                    } while (this.match(",") && !this.check("]"));
                    this.match(",");
                }
                last = this.expect("]", "expected ']' after type arguments");
            }
            const optional = this.match("?");
            const span = joinSpan(first.span, optional ? this.previous().span : last.span);
            return {
                kind: "TypeReference",
                path,
                arguments: argumentsList,
                optional,
                span,
                display: path.join(".") + (argumentsList.length ? "[" + argumentsList.map((argument) => argument.display).join(", ") + "]" : "") + (optional ? "?" : ""),
            };
        });
    }

    parseExpression() {
        return this.parseAssignment();
    }

    parseAssignment() {
        return this.withNesting(this.peek(), () => {
            const expression = this.parseOr();
            if (!this.match("=")) return expression;
            const equals = this.previous();
            const value = this.parseAssignment();
            if (expression.kind !== "IdentifierExpression" && expression.kind !== "IndexExpression" && expression.kind !== "MemberExpression") {
                this.error(equals, "the left side of an assignment must be a variable, record field, or list index");
            }
            return {
                kind: "AssignmentExpression",
                target: expression,
                value,
                span: joinSpan(expression.span, value.span),
            };
        });
    }

    parseOr() {
        let expression = this.parseAnd();
        while (this.matchKeyword("or")) {
            const operator = this.previous();
            const right = this.parseAnd();
            expression = this.makeBinary(expression, operator, right);
        }
        return expression;
    }

    parseAnd() {
        let expression = this.parseEquality();
        while (this.matchKeyword("and")) {
            const operator = this.previous();
            const right = this.parseEquality();
            expression = this.makeBinary(expression, operator, right);
        }
        return expression;
    }

    parseEquality() {
        return this.parseLeftAssociative(
            () => this.parseComparison(),
            ["==", "!="],
        );
    }

    parseComparison() {
        return this.parseLeftAssociative(
            () => this.parseAdditive(),
            ["<", "<=", ">", ">="],
        );
    }

    parseAdditive() {
        return this.parseLeftAssociative(
            () => this.parseMultiplicative(),
            ["+", "-"],
        );
    }

    parseMultiplicative() {
        return this.parseLeftAssociative(
            () => this.parseUnary(),
            ["*", "/", "%"],
        );
    }

    parseLeftAssociative(next, operators) {
        let expression = next();
        while (operators.some((operator) => this.check(operator))) {
            const token = this.advance();
            const right = next();
            expression = this.makeBinary(expression, token, right);
        }
        return expression;
    }

    parseUnary() {
        if (this.match("!", "-")) {
            const operator = this.previous();
            const operand = this.withNesting(operator, () => this.parseUnary());
            return {
                kind: "UnaryExpression",
                operator: operator.value,
                operand,
                span: joinSpan(operator.span, operand.span),
            };
        }
        return this.parsePostfix();
    }

    parsePostfix() {
        let expression = this.parsePrimary();
        while (true) {
            if (this.match("(")) {
                const args = [];
                if (!this.check(")")) {
                    do {
                    args.push(this.parseArgument());
                    } while (this.match(",") && !this.check(")"));
                    this.match(",");
                }
                const close = this.expect(")", "expected ')' after arguments");
                expression = {
                    kind: "CallExpression",
                    callee: expression,
                    arguments: args,
                    span: joinSpan(expression.span, close.span),
                };
            } else if (this.match("[")) {
                const index = this.parseExpression();
                const close = this.expect("]", "expected ']' after the index");
                expression = {
                    kind: "IndexExpression",
                    object: expression,
                    index,
                    span: joinSpan(expression.span, close.span),
                };
            } else if (this.match(".")) {
                const member = this.expectIdentifier("expected a member name after '.'");
                expression = {
                    kind: "MemberExpression",
                    object: expression,
                    name: member.value,
                    span: joinSpan(expression.span, member.span),
                };
            } else {
                break;
            }
        }
        return expression;
    }

    parseArgument() {
        if (this.checkKind("identifier") && this.peekNext().value === ":") {
            const name = this.advance();
            this.advance();
            const value = this.parseExpression();
            return { kind: "NamedArgument", name: name.value, value, span: joinSpan(name.span, value.span) };
        }
        return this.parseExpression();
    }

    parsePrimary() {
        if (this.matchKind("number")) return { kind: "LiteralExpression", value: this.previous().value, literalType: "number", span: this.previous().span };
        if (this.matchKind("string")) return { kind: "LiteralExpression", value: this.previous().value, literalType: "text", span: this.previous().span };

        if (this.matchKeyword("true")) return { kind: "LiteralExpression", value: true, literalType: "bool", span: this.previous().span };
        if (this.matchKeyword("false")) return { kind: "LiteralExpression", value: false, literalType: "bool", span: this.previous().span };
        if (this.matchKeyword("none")) return { kind: "LiteralExpression", value: null, literalType: "unit", span: this.previous().span };

        if (this.matchKind("identifier")) {
            const token = this.previous();
            if (reservedWords.has(token.value)) this.error(token, "expected an expression");
            return { kind: "IdentifierExpression", name: token.value, span: token.span };
        }

        if (this.match("(")) {
            const expression = this.parseExpression();
            this.expect(")", "expected ')' after this expression");
            return expression;
        }

        if (this.match("[")) {
            const open = this.previous();
            const elements = [];
            if (!this.check("]")) {
                do {
                    elements.push(this.parseExpression());
                } while (this.match(",") && !this.check("]"));
                this.match(",");
            }
            const close = this.expect("]", "expected ']' after the list");
            return { kind: "ListExpression", elements, span: joinSpan(open.span, close.span) };
        }

        this.error(this.peek(), "expected an expression");
    }

    makeBinary(left, operator, right) {
        return {
            kind: "BinaryExpression",
            left,
            operator: operator.value,
            right,
            span: joinSpan(left.span, right.span),
        };
    }

    expectIdentifier(message) {
        const token = this.peek();
        if (token.kind !== "identifier" || reservedWords.has(token.value)) this.error(token, message);
        return this.advance();
    }

    expect(value, message) {
        if (this.check(value)) return this.advance();
        this.error(this.peek(), message);
    }

    expectKind(kind, message) {
        if (this.checkKind(kind)) return this.advance();
        this.error(this.peek(), message);
    }

    matchKeyword(...words) {
        if (this.peek().kind !== "identifier" || !words.includes(this.peek().value)) return false;
        this.advance();
        return true;
    }

    matchKind(kind) {
        if (!this.checkKind(kind)) return false;
        this.advance();
        return true;
    }

    match(...values) {
        for (const value of values) {
            if (this.check(value)) {
                this.advance();
                return true;
            }
        }
        return false;
    }

    check(value) {
        return this.peek().kind === value || this.peek().value === value;
    }

    checkKind(kind) {
        return this.peek().kind === kind;
    }

    advance() {
        if (!this.isAtEnd()) this.current += 1;
        return this.previous();
    }

    isAtEnd() {
        return this.peek().kind === "eof";
    }

    peek() {
        return this.tokens[this.current];
    }

    peekNext() {
        return this.tokens[Math.min(this.current + 1, this.tokens.length - 1)];
    }

    previous() {
        return this.tokens[this.current - 1];
    }

    error(token, message) {
        fail("E0101", message, token.span, this.sourceName, this.source);
    }

    withNesting(token, parseNested) {
        this.nestingDepth += 1;
        try {
            if (this.nestingDepth > MAX_PARSER_NESTING) {
                this.error(token, "syntax nesting exceeds the limit of " + MAX_PARSER_NESTING);
            }
            return parseNested();
        } finally {
            this.nestingDepth -= 1;
        }
    }

    errorAtSpan(span, code, message) {
        fail(code, message, span, this.sourceName, this.source);
    }
}

function joinSpan(first, last) {
    return {
        start: first.start,
        end: last.end,
        line: first.line,
        column: first.column,
        length: Math.max(1, last.end - first.start),
    };
}

export function parse(tokens, source, sourceName = "<input>") {
    return new Parser(tokens, source, sourceName).parse();
}
