import { describe, expect, test } from "vitest";
import { iterableToStream, streamToArray, streamToIterable, streamToString } from "../utils";
import { JsonParser } from "../json-parser";
import { JsonPathDetector, type JsonPath } from "../json-path-detector";
import { JsonPathSelector } from "../json-path-selector";
import { JsonPathStreamSplitter } from "../json-path-stream-splitter";
import { JsonStringifier } from "../json-stringifier";

const testStream = [
	`{"apples":{"results":[`,
	`"apple1",`,
	`"apple2"`,
	`]},"cherries":{"results":{`,
	`"1":"cherry1",`,
	`"2":"cherry2"`,
	`}}}`
];

const testResult = JSON.parse(testStream.join(""));

describe("JsonPathStreamSplitter", () => {
	test("sub streams can be consumed when emitted", async () => {
		const stream = iterableToStream(testStream)
			.pipeThrough(new JsonParser())
			.pipeThrough(new JsonPathDetector())
			.pipeThrough(new JsonPathSelector([undefined, "results"]))
			.pipeThrough(new JsonPathStreamSplitter());

		let results: Array<{ path: JsonPath; string: string }> = [];
		for await (const subStream of streamToIterable(stream)) {
			results.push({
				path: subStream.path,
				string: await streamToString(subStream.pipeThrough(new JsonStringifier()))
			});
		}

		expect(results).toEqual([
			{
				path: ["apples", "results"],
				string: JSON.stringify(testResult.apples.results)
			},
			{
				path: ["cherries", "results"],
				string: JSON.stringify(testResult.cherries.results)
			}
		]);
	});

	test("main stream can be consumed before sub streams", async () => {
		const stream = iterableToStream(testStream)
			.pipeThrough(new JsonParser())
			.pipeThrough(new JsonPathDetector())
			.pipeThrough(new JsonPathSelector([undefined, "results"]))
			.pipeThrough(new JsonPathStreamSplitter());

		const subStreams = await streamToArray(stream);
		const results = await Promise.all(subStreams.reverse().map(async (subStream) => {
			return {
				path: subStream.path,
				string: await streamToString(subStream.pipeThrough(new JsonStringifier()))
			};
		}));

		expect(results).toEqual([
			{
				path: ["cherries", "results"],
				string: JSON.stringify(testResult.cherries.results)
			},
			{
				path: ["apples", "results"],
				string: JSON.stringify(testResult.apples.results)
			}
		]);
	});

	test("sub stream can be discarded", async () => {
		const stream = iterableToStream(testStream)
			.pipeThrough(new JsonParser())
			.pipeThrough(new JsonPathDetector())
			.pipeThrough(new JsonPathSelector([undefined, "results"]))
			.pipeThrough(new JsonPathStreamSplitter());

		let result: string | undefined = undefined;
		for await (const subStream of streamToIterable(stream)) {
			if (subStream.path[0] === "apples") {
				void subStream.cancel();
			} else {
				result = await streamToString(subStream.pipeThrough(new JsonStringifier()));
			}
		}

		expect(result).toEqual(JSON.stringify(testResult.cherries.results));
	});

	test("abortion is forwarded to all sub streams", async () => {
		const transform = new TransformStream<string, string>();

		const writer = transform.writable.getWriter();
		for (const chunk of testStream) {
			writer.write(chunk).catch(() => undefined);
		}

		const stream = transform.readable
			.pipeThrough(new JsonParser())
			.pipeThrough(new JsonPathDetector())
			.pipeThrough(new JsonPathSelector([undefined, "results"]))
			.pipeThrough(new JsonPathStreamSplitter());

		const reader = stream.getReader();
		const sub1 = await reader.read();
		const sub2 = await reader.read();

		writer.abort(new Error("test")).catch(() => undefined);

		await expect(async () => await reader.read()).rejects.toThrowError("test");
		await expect(async () => await streamToArray(sub1.value!)).rejects.toThrowError("test");
		await expect(async () => await streamToArray(sub2.value!)).rejects.toThrowError("test");
	});

	test("back pressure is applied", async () => {
		const transform = new TransformStream<string, string>();

		let chunksWritten = 0;
		const writer = transform.writable.getWriter();
		void (async () => {
			for (const chunk of testStream) {
				await writer.write(chunk);
				chunksWritten++;
			}
			await writer.close();
		})();

		const stream = transform.readable
			.pipeThrough(new JsonParser())
			.pipeThrough(new JsonPathDetector())
			.pipeThrough(new JsonPathSelector([undefined, "results"]))
			.pipeThrough(new JsonPathStreamSplitter());

		expect(chunksWritten).toBe(0);

		const reader = stream.getReader();
		await reader.read();

		await new Promise((resolve) => setTimeout(resolve, 0));
		// Each TransformStream in the pipe seems to have a small internal queue by default, so it is difficult to tell
		// how many chunks should have been consumed by now. But as long as not all of them have been consumed, it should
		// be safe to assume that some form of back pressure was applied.
		expect(chunksWritten).toBeLessThan(testStream.length);
	});
});