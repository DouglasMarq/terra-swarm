// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { EditorView } from "codemirror";
import { language } from "@codemirror/language";
import { describe, expect, it, vi } from "vitest";
import CodeEditor from "./CodeEditor";

function editorIn(container: HTMLElement): EditorView {
  const content = container.querySelector<HTMLElement>(".cm-content");
  const view = content ? EditorView.findFromDOM(content) : null;
  if (!view) throw new Error("the editor is not mounted");
  return view;
}

function renderEditor(docKey: string, initial: string) {
  const onChange = vi.fn();
  const onSave = vi.fn();
  const view = render(<CodeEditor docKey={docKey} path="/tmp/terra/src/main.ts" initial={initial} onChange={onChange} onSave={onSave} />);
  return { onChange, onSave, view };
}

describe("CodeEditor", () => {
  it("Given an opened file, when it mounts, then it shows the text and takes focus", () => {
    const { view } = renderEditor("main", "const terra = 1;");

    const editor = editorIn(view.container);
    expect(editor.state.doc.toString()).toBe("const terra = 1;");
    expect(document.activeElement).toBe(editor.contentDOM);
  });

  it("Given an opened file, when the text changes, then the new text is reported", () => {
    const { onChange, view } = renderEditor("main", "const terra = 1;");

    const editor = editorIn(view.container);
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\nexport { terra };" } });

    expect(onChange).toHaveBeenCalledWith("const terra = 1;\nexport { terra };");
  });

  it("Given an opened file, when pressing Ctrl+S, then it is saved", () => {
    const { onSave, view } = renderEditor("main", "const terra = 1;");

    fireEvent.keyDown(editorIn(view.container).contentDOM, { key: "s", code: "KeyS", ctrlKey: true });

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("Given a TypeScript file, when its language loads, then the TypeScript language is applied", async () => {
    const { view } = renderEditor("main", "const terra = 1;");

    await waitFor(() => expect(editorIn(view.container).state.facet(language)?.name).toBe("typescript"));
  });

  it("Given another document, when the key changes, then the editor reopens with the new text", () => {
    const { onChange, onSave, view } = renderEditor("main", "const terra = 1;");

    view.rerender(<CodeEditor docKey="readme" path="/tmp/terra/README" initial="# Terra" onChange={onChange} onSave={onSave} />);

    expect(editorIn(view.container).state.doc.toString()).toBe("# Terra");
    expect(view.container.querySelectorAll(".cm-editor")).toHaveLength(1);
  });

  it("Given the editor, when it unmounts, then the view is destroyed", () => {
    const { view } = renderEditor("main", "const terra = 1;");
    const destroy = vi.spyOn(editorIn(view.container), "destroy");

    view.unmount();

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
