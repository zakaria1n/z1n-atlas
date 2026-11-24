import { describe, expect, it } from "vitest";
import { decodeSourceText } from "./source-text";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("source text decoding", () => {
  it("preserves line endings and reports UTF-8 byte length", () => {
    const text = "const a = 'é';\r\nconst b = 2;\n";
    expect(decodeSourceText(bytes(text))).toEqual({
      content: text,
      size: bytes(text).length,
    });
  });
  it("removes a leading byte-order mark from content and size", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("export {}")]);
    expect(decodeSourceText(withBom)).toEqual({
      content: "export {}",
      size: bytes("export {}").length,
    });
  });
  it("rejects binary and invalid UTF-8 content", () => {
    expect(decodeSourceText(bytes("a\0b"))).toBeNull();
    expect(decodeSourceText(new Uint8Array([0x66, 0x6f, 0x80]))).toBeNull();
    expect(decodeSourceText(new Uint8Array([0xc3]))).toBeNull();
  });
  it("accepts empty content", () => {
    expect(decodeSourceText(new Uint8Array())).toEqual({
      content: "",
      size: 0,
    });
  });
});
