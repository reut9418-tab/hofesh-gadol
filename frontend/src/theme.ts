// פלטת הצבעים — בהשראת הלוגו של גוטליב את ביטון: זהב/שמפניה + גרפיט,
// בגוני פסטל בהירים ורגועים. שמות המפתחות נשמרו (teal=צבע המותג הראשי)
// כדי שכל המסכים ימשיכו לעבוד ללא שינוי.
export const T = {
  ink: '#4A443A',       // גרפיט מרוכך — טקסט ראשי
  inkSoft: '#8B8272',   // חום-אפור בהיר — טקסט משני
  paper: '#FBF8F1',     // שמנת בהירה — רקע המסך
  card: '#FFFFFF',
  line: '#EFE8D9',      // קו הפרדה עדין
  teal: '#96803F',      // זהב מעודן — צבע המותג (הדגשות/סטטוסים)
  tealSoft: '#F6F0E1',  // שמפניה פסטל — רקעים רכים
  amber: '#BC8A33',
  amberBg: '#FBF3E1',
  red: '#C05F49',
  redBg: '#FBEFEA',
  green: '#6E9161',
  greenBg: '#F0F5EC',
  // גוני מותג נוספים (הלוגו)
  gold: '#D3B26E',      // זהב בהיר — הדגשות
  goldSoft: '#EFE4C6',  // שמפניה להדגשות עדינות
  graphite: '#6A6252',  // גרפיט רך — כפתורים כהים
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
  in_progress: T.teal,
  blocked: T.red,
  ready: T.green,
  submitted: T.ink,
};

// דליי הסטטוס הנגזר (מנוע הסטטוס §13)
export const BUCKET_COLOR: Record<string, string> = {
  open: T.inkSoft,
  near: T.teal,
  blocked: T.amber,
  ready: T.green,
  submitted: T.ink,
};

// שלבי הטיפול בלקוח (לוח הלקוחות + לשונית הניהול)
export const STAGE_COLOR: Record<string, string> = {
  no_material: T.red,
  material: T.amber,
  in_treatment: T.teal,
  done: T.green,
};
