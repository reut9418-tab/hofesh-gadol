// פלטת הצבעים — בהשראת הלוגו של גוטליב את ביטון: זהב/פליז + גרפיט,
// בגוני פסטל חמימים וידידותיים. שמות המפתחות נשמרו (teal=צבע המותג הראשי)
// כדי שכל המסכים ימשיכו לעבוד ללא שינוי.
export const T = {
  ink: '#37322A',       // גרפיט חם — טקסט ראשי
  inkSoft: '#7A7062',   // גרפיט רך — טקסט משני
  paper: '#FAF6EE',     // קרם חם — רקע המסך
  card: '#FFFFFF',
  line: '#EAE1CF',      // קו הפרדה חמים
  teal: '#9A7B2F',      // פליז/זהב עמוק — צבע המותג הראשי (כפתורים/כותרות)
  tealSoft: '#F4ECDA',  // זהב פסטל — רקעים רכים
  amber: '#B4720F',
  amberBg: '#FBF1DD',
  red: '#B3452E',
  redBg: '#FBEAE5',
  green: '#4C7A45',
  greenBg: '#EBF2E7',
  // גוני מותג נוספים (הלוגו)
  gold: '#C9A03C',      // זהב בהיר — הדגשות
  goldSoft: '#E7D3A0',  // זהב פסטל להדגשות עדינות
  graphite: '#3E3830',  // גרפיט הכהה של הלוגו — כותרת עליונה
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
