// Used by Docker; don't print the request, response, or credentials.
try {
  if (!process.env.BOT_API_SECRET) process.exitCode = 1;
  else {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || '8080'}/health`, {
      headers: { 'X-BX-Secret': process.env.BOT_API_SECRET }, signal: AbortSignal.timeout(3000), redirect: 'error',
    });
    if (!response.ok) process.exitCode = 1;
    await response.body?.cancel();
  }
} catch {
  process.exitCode = 1;
}
