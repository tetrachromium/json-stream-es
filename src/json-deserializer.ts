import type { JsonPath, JsonChunkWithPath } from "./path-selector";
import { JsonChunkType, StringRole, type JsonChunk, type JsonValue } from "./types";
import { AbstractTransformStream } from "./utils";

enum StateType {
	ROOT = "ROOT",
	OBJECT_PROPERTY = "OBJECT_PROPERTY",
	ARRAY_ITEM = "ARRAY_ITEM"
};

type AnyState<C extends JsonChunk & { path?: JsonPath }> = (
	{
		type: StateType.ROOT;
		value: JsonValue | undefined;
		path: C["path"];
	} | {
		type: StateType.OBJECT_PROPERTY;
		object: Record<string, JsonValue>;
		key: string;
		value: JsonValue | undefined;
		parent: State<C>;
	} | {
		type: StateType.ARRAY_ITEM;
		array: Array<JsonValue>;
		value: JsonValue | undefined;
		parent: State<C>
	}
);

type State<C extends JsonChunk & { path?: JsonPath }, Type extends StateType = StateType> = Extract<AnyState<C>, { type: Type }>;

export type JsonValueAndPath<C extends JsonChunk & { path?: JsonPath }> = { value: JsonValue; path: C["path"] };

/**
 * Converts a stream of JsonChunks into JsonValues. The input stream may contain multiple JSON documents on the root level, as
 * produced by PathFilter or by concatenating multiple JsonChunk streams.
 */
export class JsonDeserializer<C extends JsonChunk & { path?: JsonPath } = JsonChunkWithPath> extends AbstractTransformStream<C, JsonValueAndPath<C>> {
	protected state: State<C> = { type: StateType.ROOT, value: undefined, path: [] };

	protected handleValueEnd(controller: TransformStreamDefaultController<JsonValueAndPath<C>>): void {
		if (this.state.type === StateType.ROOT) {
			if (this.state.value !== undefined) {
				controller.enqueue({ value: this.state.value, path: this.state.path });
			}
			this.state.value = undefined;
		} else if (this.state.type === StateType.OBJECT_PROPERTY) {
			if (this.state.value !== undefined) {
				this.state.object[this.state.key] = this.state.value;
			}
			this.state.key = "";
			this.state.value = undefined;
		} else if (this.state.type === StateType.ARRAY_ITEM) {
			if (this.state.value !== undefined) {
				this.state.array.push(this.state.value);
			}
			this.state.value = undefined;
		}
	}

	protected override transform(chunk: C, controller: TransformStreamDefaultController<JsonValueAndPath<C>>): void {
		if (chunk.type === JsonChunkType.NUMBER_VALUE || chunk.type === JsonChunkType.BOOLEAN_VALUE || chunk.type === JsonChunkType.NULL_VALUE) {
			this.state.value = chunk.value;
			if (this.state.type === StateType.ROOT) {
				this.state.path = chunk.path;
			}
			this.handleValueEnd(controller);
		}

		else if (chunk.type === JsonChunkType.STRING_START && chunk.role === StringRole.VALUE) {
			this.state.value = "";
			if (this.state.type === StateType.ROOT) {
				this.state.path = chunk.path;
			}
		}
		else if (chunk.type === JsonChunkType.STRING_CHUNK && chunk.role === StringRole.VALUE) {
			this.state.value += chunk.value;
		}
		else if (chunk.type === JsonChunkType.STRING_END && chunk.role === StringRole.VALUE) {
			this.handleValueEnd(controller);
		}

		else if (chunk.type === JsonChunkType.ARRAY_START) {
			this.state.value = [];
			if (this.state.type === StateType.ROOT) {
				this.state.path = chunk.path;
			}
			this.state = {
				type: StateType.ARRAY_ITEM,
				array: this.state.value,
				value: undefined,
				parent: this.state
			};
		} else if (chunk.type === JsonChunkType.ARRAY_END && this.state.type === StateType.ARRAY_ITEM) {
			this.state = this.state.parent;
			this.handleValueEnd(controller);
		}

		else if (chunk.type === JsonChunkType.OBJECT_START) {
			this.state.value = {};
			if (this.state.type === StateType.ROOT) {
				this.state.path = chunk.path;
			}
			this.state = {
				type: StateType.OBJECT_PROPERTY,
				object: this.state.value,
				key: "",
				value: undefined,
				parent: this.state
			};
		} else if (chunk.type === JsonChunkType.OBJECT_END && this.state.type === StateType.OBJECT_PROPERTY) {
			this.state = this.state.parent;
			this.handleValueEnd(controller);
		} else if (chunk.type === JsonChunkType.STRING_CHUNK && chunk.role === StringRole.KEY && this.state.type === StateType.OBJECT_PROPERTY) {
			this.state.key += chunk.value;
		}
	}
}