export function MarkdownContent({ markdown }: { markdown: string }) {
  const blocks = markdown.split(/\n\s*\n/);
  const occurrences = new Map<string, number>();

  return (
    <div className="prose">
      {blocks.map((block) => {
        const occurrence = occurrences.get(block) ?? 0;
        occurrences.set(block, occurrence + 1);
        const key = `${block}-${occurrence}`;

        if (block.startsWith("## ")) {
          return <h2 key={key}>{block.slice(3)}</h2>;
        }

        return <p key={key}>{block}</p>;
      })}
    </div>
  );
}
