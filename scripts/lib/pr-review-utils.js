function formatCommentSummary(body, maxLength = 160) {
  const normalized = String(body || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function isBotAuthor(login) {
  return String(login || "").includes("[bot]");
}

function buildReviewThreads(comments) {
  const threads = new Map();
  comments.forEach((comment) => {
    if (comment.in_reply_to_id) {
      const root = threads.get(comment.in_reply_to_id);
      if (root) {
        root.replies.push(comment);
      }
      return;
    }
    threads.set(comment.id, { root: comment, replies: [] });
  });
  return threads;
}

function listActionableThreads(threads, viewerLogin) {
  const actionable = [];

  threads.forEach(({ root, replies }) => {
    const threadComments = [root, ...replies].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const latest = threadComments[threadComments.length - 1];
    if (latest.user?.login === viewerLogin) {
      return;
    }

    actionable.push({
      id: root.id,
      author: root.user?.login || "unknown",
      path: root.path || "(general)",
      line: root.original_line || root.line || "-",
      isBot: isBotAuthor(root.user?.login || ""),
      url: root.html_url,
      summary: formatCommentSummary(root.body || "")
    });
  });

  actionable.sort((a, b) => {
    if (a.isBot !== b.isBot) return a.isBot ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return actionable;
}

module.exports = {
  buildReviewThreads,
  formatCommentSummary,
  isBotAuthor,
  listActionableThreads
};
