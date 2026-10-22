import { describe, expect, it } from "vitest";
import { decodeEntities, parseAgentHtml } from "@/lib/agent-html";

describe("parseAgentHtml", () => {
  it("Subset wird zum Baum, Entities werden Text", () => {
    expect(parseAgentHtml("✅ <b>minecraft_restart</b>\n<code>a &lt;b&gt; &amp; c</code>")).toEqual([
      { type: "text", text: "✅ " },
      { type: "b", children: [{ type: "text", text: "minecraft_restart" }] },
      { type: "text", text: "\n" },
      { type: "code", children: [{ type: "text", text: "a <b> & c" }] },
    ]);
  });

  it("verschachtelt und <pre> mit Zeilenumbrüchen", () => {
    expect(parseAgentHtml("<i>x <b>y</b></i><pre>l1\nl2</pre>")).toEqual([
      { type: "i", children: [{ type: "text", text: "x " }, { type: "b", children: [{ type: "text", text: "y" }] }] },
      { type: "pre", children: [{ type: "text", text: "l1\nl2" }] },
    ]);
  });

  it("unbekannte oder unpassende Tags bleiben sichtbarer Text, nie HTML", () => {
    expect(parseAgentHtml('<script>alert(1)</script><a href="x">y</a>')).toEqual([{ type: "text", text: '<script>alert(1)</script><a href="x">y</a>' }]);
    expect(parseAgentHtml("<b>offen</i>")).toEqual([{ type: "b", children: [{ type: "text", text: "offen</i>" }] }]);
    expect(parseAgentHtml("</b>x")).toEqual([{ type: "text", text: "</b>x" }]);
  });

  it("decodeEntities lässt Unbekanntes stehen", () => {
    expect(decodeEntities("&lt;&gt;&amp;&quot;&#39;&nbsp;")).toBe("<>&\"'&nbsp;");
  });
});
