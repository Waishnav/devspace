export const meta = {
  name: "bounded-repair",
  description: "Attempt a repair at most three times, verifying after each attempt"
};
let feedback = args.task;
for (let attempt = 1; attempt <= 3; attempt++) {
  phase(`Repair ${attempt}`);
  await agent(`Implement the following repair in this workspace: ${feedback}`);
  phase(`Verify ${attempt}`);
  const result = await agent(`Verify the requested task: ${args.task}. Run the relevant checks.`, {
    schema: {
      type: "object",
      properties: { passed: { type: "boolean" }, feedback: { type: "string" } },
      required: ["passed", "feedback"], additionalProperties: false
    }
  });
  if (result?.passed) return result;
  feedback = result?.feedback ?? feedback;
}
return { passed: false, feedback };
