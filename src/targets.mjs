import { fail } from "./diagnostics.mjs";

export const TARGETS = Object.freeze({
    host: Object.freeze({ capabilities: new Set(["output"]) }),
    web: Object.freeze({ capabilities: new Set(["output"]) }),
    embedded: Object.freeze({ capabilities: new Set(["output", "serial", "gpio"]) }),
});

const builtinEffects = Object.freeze({ print: "output", serial_write: "serial", gpio_write: "gpio" });

export function validateTargetEffects(program, context, target) {
    const definition = TARGETS[target];
    if (!definition) {
        fail("E3003", "target '" + target + "' is not supported; choose host, web, or embedded", program.span, context.sourceName, context.sourceText);
    }

    const scopes = [new Set()];
    for (const declaration of program.declarations) visitStatement(declaration, scopes, context, target, definition.capabilities);
}

function visitStatement(statement, scopes, context, target, capabilities) {
    switch (statement.kind) {
        case "BindingDeclaration":
            visitExpression(statement.initializer, scopes, context, target, capabilities);
            scopes.at(-1).add(statement.name);
            return;
        case "FunctionDeclaration":
            scopes.at(-1).add(statement.name);
            scopes.push(new Set(statement.parameters.map(({ name }) => name)));
            visitStatement(statement.body, scopes, context, target, capabilities);
            scopes.pop();
            return;
        case "BlockStatement":
            scopes.push(new Set());
            for (const child of statement.declarations) visitStatement(child, scopes, context, target, capabilities);
            scopes.pop();
            return;
        case "ExpressionStatement":
            visitExpression(statement.expression, scopes, context, target, capabilities);
            return;
        case "IfStatement":
            visitExpression(statement.condition, scopes, context, target, capabilities);
            visitStatement(statement.thenBranch, scopes, context, target, capabilities);
            if (statement.elseBranch) visitStatement(statement.elseBranch, scopes, context, target, capabilities);
            return;
        case "WhileStatement":
            visitExpression(statement.condition, scopes, context, target, capabilities);
            visitStatement(statement.body, scopes, context, target, capabilities);
            return;
        case "ForStatement":
            visitExpression(statement.iterable, scopes, context, target, capabilities);
            scopes.push(new Set([statement.name]));
            visitStatement(statement.body, scopes, context, target, capabilities);
            scopes.pop();
            return;
        case "ReturnStatement":
            visitExpression(statement.value, scopes, context, target, capabilities);
            return;
        case "MatchStatement":
            visitExpression(statement.value, scopes, context, target, capabilities);
            for (const matchCase of statement.cases) {
                scopes.push(new Set(patternBindings(matchCase.pattern)));
                visitStatement(matchCase.body, scopes, context, target, capabilities);
                scopes.pop();
            }
            return;
        case "ImportDeclaration":
            scopes.at(-1).add(statement.alias);
            return;
        default:
            return;
    }
}

function visitExpression(expression, scopes, context, target, capabilities, directCallee = false) {
    if (!expression) return;
    switch (expression.kind) {
        case "IdentifierExpression": {
            const isGlobalTargetBuiltin = Object.hasOwn(builtinEffects, expression.name) && !isShadowed(scopes, expression.name);
            const targetSpecific = expression.name === "serial_write" || expression.name === "gpio_write";
            if (isGlobalTargetBuiltin && targetSpecific && !directCallee) {
                fail("E3004", "target-specific API '" + expression.name + "' must be called directly so OMNI can check its capability", expression.span, context.sourceName, context.sourceText);
            }
            return;
        }
        case "CallExpression": {
            const callee = expression.callee;
            if (callee.kind === "IdentifierExpression" && !isShadowed(scopes, callee.name)) {
                const capability = builtinEffects[callee.name];
                if (capability && !capabilities.has(capability)) {
                    fail(
                        "E3004",
                        "target '" + target + "' does not provide the '" + capability + "' capability required by '" + callee.name + "'; this API is available on the embedded target",
                        callee.span,
                        context.sourceName,
                        context.sourceText,
                    );
                }
            }
            visitExpression(callee, scopes, context, target, capabilities, true);
            for (const argument of expression.arguments) visitExpression(argument.value ?? argument, scopes, context, target, capabilities);
            return;
        }
        case "ListExpression":
            for (const element of expression.elements) visitExpression(element, scopes, context, target, capabilities);
            return;
        case "UnaryExpression":
            visitExpression(expression.operand, scopes, context, target, capabilities);
            return;
        case "BinaryExpression":
            visitExpression(expression.left, scopes, context, target, capabilities);
            visitExpression(expression.right, scopes, context, target, capabilities);
            return;
        case "AssignmentExpression":
            visitExpression(expression.target, scopes, context, target, capabilities);
            visitExpression(expression.value, scopes, context, target, capabilities);
            return;
        case "IndexExpression":
            visitExpression(expression.object, scopes, context, target, capabilities);
            visitExpression(expression.index, scopes, context, target, capabilities);
            return;
        case "MemberExpression":
            visitExpression(expression.object, scopes, context, target, capabilities);
            return;
        default:
            return;
    }
}

function isShadowed(scopes, name) {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
        if (scopes[index].has(name)) return true;
    }
    return false;
}

function patternBindings(pattern) {
    if (pattern.kind === "BindingPattern") return [pattern.name];
    if (pattern.kind === "ConstructorPattern") return pattern.fields.flatMap(patternBindings);
    return [];
}
