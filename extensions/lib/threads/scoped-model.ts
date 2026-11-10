type Model = { provider: string; id: string };

export function scopedModel(
  requested: string | undefined,
  current: Model | undefined,
  scoped: readonly { model: Model }[],
): string | undefined {
  if (scoped.length === 0) return requested;
  const models = [...new Map(scoped.map(({ model }) => [`${model.provider}/${model.id}`, model])).values()];
  if (requested !== undefined) {
    const exact = models.filter((model) => `${model.provider}/${model.id}` === requested);
    const matches = exact.length ? exact : models.filter((model) => model.id === requested);
    if (matches.length !== 1)
      throw new Error(`Model ${JSON.stringify(requested)} is not an unambiguous scoped model. Select one with /scoped-models.`);
    return `${matches[0].provider}/${matches[0].id}`;
  }
  const selected = models.find((model) => model.provider === current?.provider && model.id === current.id) ?? models[0];
  return `${selected.provider}/${selected.id}`;
}
