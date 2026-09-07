/* קבועים ולוגיקת תחום מהמפרט (README §4, §6, §13).
   מרוכז כאן כדי שכל המודולים הבאים ישתמשו במקור אמת אחד. */

const FRAMEWORKS = ['schools', 'gardens', 'prep'];
const PROGRAMS = ['base15', 'extension', 'base'];

const FRAMEWORK_HE = { schools: 'בתי ספר', gardens: 'גנים', prep: 'מכינות קיץ' };
const PROGRAM_HE = { base15: '15 יום', extension: 'הרחבה', base: '' };

/* תקרת ברוטו שעתי לפי סוג תוכנית (§6) */
const GROSS_CAP = { schools_gardens: 120, summer_prep: 150 };

/* תקרות שעות לפי תפקיד (§4) — לתוכנית 15 יום; בהרחבה: שעות-ליום × ימי הרחבה */
const ROLE_CAPS = {
  coordinator:        { hoursPerDay: 7.6, cap15: 114 }, // רכז
  deputy_coordinator: { hoursPerDay: 6.2, cap15: 93 },  // סגן רכז (רק בי"ס >150)
  staff:              { hoursPerDay: 6.0, cap15: 90 },  // מורה/גננת/מובילה/סייעת
};

function programType(framework) {
  return framework === 'prep' ? 'summer_prep' : 'schools_gardens';
}

function reportLabel(framework, program) {
  const f = FRAMEWORK_HE[framework] || framework;
  if (framework === 'prep') return f;
  const p = PROGRAM_HE[program] || program;
  return `${f} — ${p}`;
}

/* תקרת שעות בפועל לתפקיד בדוח נתון (מתחשב בהרחבה) */
function hoursCap(roleKey, program, extensionDays) {
  const role = ROLE_CAPS[roleKey];
  if (!role) return null;
  if (program === 'extension') return role.hoursPerDay * (extensionDays || 0);
  return role.cap15;
}

module.exports = {
  FRAMEWORKS, PROGRAMS, FRAMEWORK_HE, PROGRAM_HE, GROSS_CAP, ROLE_CAPS,
  programType, reportLabel, hoursCap,
};
