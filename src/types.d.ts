// Markdown files imported with `with { type: "text" }` are embedded in the binary as strings.
declare module "*.md" {
  const text: string;
  export default text;
}
