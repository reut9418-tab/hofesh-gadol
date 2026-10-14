#!/bin/sh
# שער רגרסיה לפני דחיפה (רעות 14.10.2026) — כל push מפעיל דיפלוי לאתר,
# ולכן קודם מריצים את כל המסכים על דוחות אמיתיים ומשווים לתמונת המצב.
# עקיפה מפורשת: REGRESS_SKIP=1 git push
# התקנה: cp backend/scripts/pre-push.sh .git/hooks/pre-push
if [ "$REGRESS_SKIP" = "1" ]; then echo "⚠ שער הרגרסיה דולג (REGRESS_SKIP=1)"; exit 0; fi
ROOT="$(git rev-parse --show-toplevel)"
echo "▶ שער רגרסיה לפני דחיפה (כ-6 דקות)…"
node "$ROOT/backend/scripts/regress.js" 2>&1
STATUS=$?
if [ "$STATUS" != "0" ]; then
  echo ""
  echo "✗ הדחיפה נעצרה. שינוי מכוון? node backend/scripts/regress.js --update ואז git push שוב. עקיפה: REGRESS_SKIP=1 git push"
  exit 1
fi
