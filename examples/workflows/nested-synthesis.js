export const meta = {
  name: "nested-synthesis",
  description: "Run a saved review workflow for each group, then synthesize results"
};
const results = await parallel(args.groups.map(group => () =>
  workflow("review-and-verify", { areas: group })
));
return await agent(`Synthesize these verified group reviews, preserving failed coverage: ${JSON.stringify(results)}`);
