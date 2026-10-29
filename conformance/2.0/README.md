# Conformance fixtures

Files that every engine of JSON Templates uses in its tests, so that the engines are checked against the same expectations.

- The templates and their data are the examples of the specification, in `../../examples/2.0/`.
- `expectations.json` has, for each example and each of its data files, the texts that the rendered document must contain (`contains`) and, optionally, the texts that it must not (`absent`), which is how the rules are checked.
- `formats/<name>.json` has, for the named format `<name>`, the text it gives for some values (`cases`) and the values it rejects (`invalid`). Every engine that has the format must give them.
- `twig/compiled/` has the Twig that the Twig compiler gives for each example. Every Twig compiler must give it byte for byte.
- `twig/node-scenarios.json` has, for the nodes of the specification in a given context (`block`, `inline` or `horizontal`), the Twig that the Twig compiler gives for each one.

A compiler for another format keeps its own expected output in its own repository: the Twig files here are the reference of the Twig format only.
