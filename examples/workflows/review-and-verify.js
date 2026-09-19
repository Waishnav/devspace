export const meta = {
  name: "review-and-verify",
  description: "Review independent project areas and verify the combined findings",
  phases: [{ title: "Review" }, { title: "Verify" }]
};
phase("Review");
const reviews = await parallel(args.areas.map(area => () =>
  agent(`Review ${area}. Return actionable findings with file references. Do not modify files.`, { label: area })
));
phase("Verify");
return await agent(`Verify these findings against the current workspace and report which are confirmed: ${JSON.stringify(reviews)}`);
