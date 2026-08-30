/**
 * The tool registry: the single place that maps a tool name to its
 * {@link ToolDefinition}, and the only source of the tool catalogue.
 *
 * It is intentionally small and strict:
 *   - `register` rejects a duplicate name loudly — two tools answering to one name
 *     is a wiring bug, not a runtime condition to paper over.
 *   - `resolve` throws {@link UnknownToolError} for an unregistered name, so an
 *     unknown tool can never fall through to `undefined` and be executed.
 *   - `list` returns metadata only ({@link ToolMetadata}) in deterministic
 *     (name-sorted) order. It never exposes a connector or anything secret.
 *
 * Definitions are supplied in code (reviewed, not user-provided), so there is no
 * dynamic-registration or code-loading path here.
 */

import { DuplicateToolRegistrationError, UnknownToolError } from '@/domain/tool-errors.js';
import { toToolMetadata } from '@/domain/tool.js';
import type { ToolDefinition, ToolMetadata } from '@/domain/tool.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /** Register a tool. Throws {@link DuplicateToolRegistrationError} on a name clash. */
  register<Args>(definition: ToolDefinition<Args>): this {
    if (this.tools.has(definition.name)) {
      throw new DuplicateToolRegistrationError(definition.name);
    }
    // The registry stores definitions type-erased; the executor re-establishes the
    // argument type by parsing through the definition's own `inputSchema`.
    this.tools.set(definition.name, definition as ToolDefinition);
    return this;
  }

  /** Whether a tool with this name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Resolve a tool by name, or throw {@link UnknownToolError}. */
  resolve(name: string): ToolDefinition {
    const definition = this.tools.get(name);
    if (definition === undefined) {
      throw new UnknownToolError(name);
    }
    return definition;
  }

  /** All registered tools as non-secret metadata, sorted by name for determinism. */
  list(): ToolMetadata[] {
    return [...this.tools.values()]
      .map(toToolMetadata)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
