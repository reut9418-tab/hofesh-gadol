// פלטת הצבעים — בהשראת הלוגו של גוטליב את ביטון: זהב/שמפניה + גרפיט,
// בגוני פסטל בהירים ורגועים. שמות המפתחות נשמרו (teal=צבע המותג הראשי)
// כדי שכל המסכים ימשיכו לעבוד ללא שינוי.
export const T = {
  ink: '#413A2F',       // גרפיט חם — טקסט ראשי
  inkSoft: '#82786A',   // חום-אפור — טקסט משני
  paper: '#FDFBF6',     // בהיר מאוד — רקע המסך
  card: '#FFFFFF',
  line: '#EDE5D4',      // קו הפרדה עדין
  teal: '#A8842B',      // זהב המותג — הדגשות וכפתורים
  tealSoft: '#F4EAD1',  // שמפניה פסטל — רקעים רכים
  amber: '#D08A2E',     // אפרסק — אזהרות
  amberBg: '#FAEEDA',
  red: '#C96A54',       // קורל פסטלי — שגיאות
  redBg: '#F9E7E1',
  green: '#679B54',     // ירוק מרווה — תקין/הושלם
  greenBg: '#E9F2E2',
  blue: '#5E8FA8',      // תכלת מאובקת — "בטיפול"/לקראת סיום
  blueBg: '#E7F0F4',
  // גוני מותג נוספים (הלוגו)
  gold: '#C9A03C',      // זהב הלוגו — הדגשות
  goldSoft: '#EBDCB2',  // שמפניה עמוקה
  graphite: '#4A4437',  // גרפיט הלוגו — כפתורים כהים
};

// תוויות סטטוס לדוח (§13)
export const STATUS_HE: Record<string, string> = {
  draft: 'טיוטה',
  in_progress: 'בעבודה',
  blocked: 'חסום',
  ready: 'מוכן להגשה',
  submitted: 'הוגש',
};

export const STATUS_COLOR: Record<string, string> = {
  draft: T.inkSoft,
  in_progress: T.blue,
  blocked: T.red,
  ready: T.green,
  submitted: T.ink,
};

// דליי הסטטוס הנגזר (מנוע הסטטוס §13)
export const BUCKET_COLOR: Record<string, string> = {
  open: T.inkSoft,
  near: T.blue,
  blocked: T.amber,
  ready: T.green,
  submitted: T.ink,
};

// שלבי הטיפול בלקוח (לוח הלקוחות + לשונית הניהול)
export const STAGE_COLOR: Record<string, string> = {
  no_material: T.red,
  material: T.amber,
  in_treatment: T.blue,
  done: T.green,
};
