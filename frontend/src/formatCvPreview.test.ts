import { expect, test } from "vitest";
import { formatCvPreview } from "./formatCvPreview";

test("reconnects the observed PDF word fragments and preserves headings and bullets", () => {
  // Non-identifying excerpts with the actual stored word / space-only-line pattern.
  const extracted = "I\n \ndesign\n \nREST\n \nAPIs,\n \nmodel\n \nrelational\n \ndata,\n \nwrite\n \nautomated\n \ntests\n \nand\n \ndeploy\n \nfull-stack\n \napplications\n \nusing\n \nmodern\n \ndevelopment\n \ntools\n \nsuch\n \nas\n \nOpenAI\n \nCodex.\n \n  \nTechnical  Projects\n●\nContinue\n \nto\n \ndevelop\n \nnew\n \nsoftware\n \nprojects\n \nand\n \nexpand\n \nmy\n \nportfolio.";

  expect(formatCvPreview(extracted)).toBe(
    "I design REST APIs, model relational data, write automated tests and deploy full-stack applications using modern development tools such as OpenAI Codex.\n\nTechnical  Projects\n● Continue to develop new software projects and expand my portfolio.",
  );
});

test("retains legitimate paragraphs, headings and list items alongside extracted fragments", () => {
  const ordinary = "PROFILE\nA developer who builds reliable services.\n\nA separate paragraph about collaboration.\n\nExperience\n- Built a service.\n- Maintained its tests.\n\nSkills\nPython\nSQL";
  const extracted = "Built a backend with automated tests and deployed\non\n \nUbuntu\n \nwith\n \nNginx.\n \n \n●\n \nAdded\n \nnew\n \nbackend\n \ntests.\n●\n \nMaintained\n \nthe\n \nexisting\n \ntests.";

  expect(formatCvPreview(ordinary)).toBe(ordinary);
  expect(formatCvPreview(`${ordinary}\n\n${extracted}`)).toBe(
    `${ordinary}\n\nBuilt a backend with automated tests and deployed on Ubuntu with Nginx.\n\n● Added new backend tests.\n● Maintained the existing tests.`,
  );
});
