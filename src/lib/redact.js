const WEBHOOK_CREDENTIAL = /https?:\/\/(?:[a-z]+\.)?(?:discord\.com|discordapp\.com)\/api\/(?:v\d+\/)?webhooks\/\d+\/[a-z0-9_.-]+/giu;

export function createRedactor(secrets = []) {
  const values = [...new Set(secrets.filter((value) => typeof value === 'string' && value))]
    .sort((a, b) => b.length - a.length);
  return (value) => {
    let text = value.replace(WEBHOOK_CREDENTIAL, '[webhook مخفي]');
    for (const secret of values) text = text.replaceAll(secret, '****');
    return text;
  };
}
