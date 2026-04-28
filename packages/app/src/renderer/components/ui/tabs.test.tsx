import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

describe("Tabs", () => {
  test("renders controlled tabs without Radix Presence", () => {
    const markup = renderToStaticMarkup(
      <Tabs value="tool" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="tool">Tool</TabsTrigger>
          <TabsTrigger value="session">Session</TabsTrigger>
        </TabsList>
        <TabsContent value="tool">Tool panel</TabsContent>
        <TabsContent value="session">Session panel</TabsContent>
      </Tabs>,
    );

    expect(markup).toContain('data-slot="tabs"');
    expect(markup).toContain('data-state="active"');
    expect(markup).toContain('data-state="inactive"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('hidden=""');
  });
});
