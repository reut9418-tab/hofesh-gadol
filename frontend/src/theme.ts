// פלטת הצבעים המשותפת (זהה לאב-הטיפוס, לרציפות ויזואלית)
export const T = {
  ink: '#182A33',
  inkSoft: '#4A5D66',
  paper: '#F5F7F6',
  card: '#FFFFFF',
  line: '#DCE4E2',
  teal: '#17656D',
  tealSoft: '#E3EFEF',
  amber: '#B4720F',
  amberBg: '#FBF1DD',
  red: '#B3261E',
  redBg: '#FBE7E5',
  green: '#1E6B3C',
  greenBg: '#E4F2E8',
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
