import { useEffect, useEffectEvent, useRef } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

export interface CodeEditorProps {
  /** Identifies the document; a new one resets the editor. */
  docKey: string;
  path: string;
  initial: string;
  onChange: (text: string) => void;
  onSave: () => void;
}

const theme = EditorView.theme(
  {
    "&": { height: "100%", color: "var(--terra-text)", backgroundColor: "var(--terra-terminal-bg)", fontSize: "12.5px" },
    ".cm-scroller": { fontFamily: "var(--terra-font-mono)", lineHeight: "1.55" },
    ".cm-content": { caretColor: "var(--terra-accent)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--terra-accent)" },
    ".cm-gutters": { backgroundColor: "var(--terra-terminal-bg)", color: "var(--terra-text-faint)", border: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--terra-bg-hover)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgb(250 250 250 / 16%)" },
    ".cm-panels": { backgroundColor: "var(--terra-bg-elevated)", color: "var(--terra-text)" },
    ".cm-searchMatch": { backgroundColor: "var(--terra-amber-dim)" },
  },
  { dark: true },
);

/** CodeMirror 6 with the language guessed from the file name. Loaded lazily. */
export default function CodeEditor({ docKey, path, initial, onChange, onSave }: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  const openedDocument = useEffectEvent(() => ({ initial, path }));

  useEffect(() => {
    if (!host.current) return;
    const { initial, path } = openedDocument();
    const language = new Compartment();
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          keymap.of([
            indentWithTab,
            { key: "Mod-s", preventDefault: true, run: () => (handlers.current.onSave(), true) },
          ]),
          theme,
          language.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.focus();
    let disposed = false;
    const description = LanguageDescription.matchFilename(languages, path.split("/").pop() ?? path);
    void description?.load().then((support) => {
      if (!disposed) view.dispatch({ effects: language.reconfigure(support) });
    });
    return () => {
      disposed = true;
      view.destroy();
    };
    // The editor owns the text after mount; only a new document resets it.
  }, [docKey]);

  return <div ref={host} className="terra-editor-host" />;
}
