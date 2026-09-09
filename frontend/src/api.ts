import axios from 'axios';

// בפיתוח: שרת מקומי; בענן (build): אותו דומיין
export const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3101/api';
const api = axios.create({ baseURL: API_BASE });

/* שרת ה-Render החינמי נרדם אחרי רבע שעה ללא שימוש; הבקשה הראשונה אליו נכשלת
   או אורכת עד דקה. שתי הגנות: (1) פינג התעוררות ברגע שהאפליקציה נפתחת,
   (2) לפני העלאת קובץ ממתינים שהשרת יענה ל-health כדי שההעלאה לא תיפול. */
const ping = () => fetch(`${API_BASE}/health`).then((r) => r.ok);
if (import.meta.env.PROD) ping().catch(() => {});

export async function wakeServer(): Promise<void> {
  for (let i = 0; i < 9; i++) {
    try { if (await ping()) return; } catch { /* עדיין מתעורר */ }
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw Object.assign(new Error('server asleep'), {
    response: { data: { error: 'השרת בענן לא מגיב — נסי לרענן את הדף ולנסות שוב בעוד דקה.' } },
  });
}

/* תשובת שגיאה בלי JSON (למשל 502 בזמן שהשרת מתעורר, או ניתוק) → הודעה ברורה */
api.interceptors.response.use(undefined, (e) => {
  const hasJsonError = typeof e?.response?.data === 'object' && e.response.data?.error;
  if (!hasJsonError) {
    e.response = {
      ...(e.response || {}),
      data: { error: 'השרת בענן התעורר משינה באמצע הבקשה — המתיני חצי דקה ונסי שוב.' },
    };
  }
  return Promise.reject(e);
});

export type Health = {
  bucket: 'open' | 'near' | 'blocked' | 'ready' | 'submitted';
  bucketLabel: string;
  completion: number;
  ingest: { participants: boolean; cost_report: boolean; ledger: boolean };
  present: number;
  exceptions: { errors: number; warnings: number };
  costWorkers: number;
  costTotal: number;
  institutions: number;
  underUtilization: number | null;
  todos: string[];
};

export type Report = {
  id: number;
  client_id: number;
  authority_id: number | null;
  framework: 'schools' | 'gardens' | 'prep';
  program: string;
  extension_days: number;
  status: string;
  label: string;
  program_type: 'schools_gardens' | 'summer_prep';
  ingest: { cost_report: boolean; ledger: boolean; participants: boolean };
  health?: Health;
};

export type Alert = { urgency: number; level: 'err' | 'warn' | 'ok'; reportId: number; clientId: number; text: string };
export type DashStatus = {
  buckets: Record<string, number>;
  bucketLabels: Record<string, string>;
  alerts: Alert[];
  alertsTotal: number;
  moneyOnTable: number;
  totalReports: number;
  pipeline?: {
    counts: Record<string, number>;
    labels: Record<string, string>;
    clients: { id: number; name: string; stage: string; stageLabel: string; manual: boolean }[];
  };
};

export type Authority = { id: number; client_id: number; name: string; reports: Report[] };

export type ManageData = {
  quote_sent?: boolean; quote_signed?: boolean; budget_built?: boolean; invoice_sent?: boolean;
  docs_mail_sent?: boolean; material_arrived?: boolean; material_date?: string;
  got_exec_reports?: boolean; got_cost_reports?: boolean;
  handler?: string; price?: string;
  email1?: string; phone1?: string; email2?: string; phone2?: string;
  [k: string]: any;
};

export type ClientNode = {
  id: number;
  name: string;
  has_vat: boolean;
  cluster_number: number | null;
  notes: string | null;
  stage?: string;
  stageLabel?: string;
  stageLabels?: Record<string, string>;
  manage_status?: string | null;
  manage_notes?: string | null;
  manageData?: ManageData;
  alerts?: Alert[];
  directReports: Report[];
  authorities: Authority[];
};

export type Dashboard = {
  clients: number;
  authorities: number;
  reports: number;
  status: DashStatus;
};

export const getTree = () => api.get<ClientNode[]>('/clients/tree').then((r) => r.data);
export const getDashboard = () => api.get<Dashboard>('/clients/dashboard').then((r) => r.data);
export const getClient = (id: number) => api.get<ClientNode>(`/clients/${id}`).then((r) => r.data);
export const createClient = (body: any) => api.post('/clients', body).then((r) => r.data);
export const updateClient = (id: number, body: any) => api.put(`/clients/${id}`, body).then((r) => r.data);
export const deleteClient = (id: number) => api.delete(`/clients/${id}`).then((r) => r.data);
export const createAuthority = (clientId: number, name: string) =>
  api.post(`/clients/${clientId}/authorities`, { name }).then((r) => r.data);
export const deleteAuthority = (id: number) => api.delete(`/authorities/${id}`).then((r) => r.data);
export const createReport = (body: any) => api.post('/reports', body).then((r) => r.data);
export const getReport = (id: number) => api.get(`/reports/${id}`).then((r) => r.data);
export const updateReport = (id: number, body: any) => api.put(`/reports/${id}`, body).then((r) => r.data);
export const deleteReport = (id: number) => api.delete(`/reports/${id}`).then((r) => r.data);

/* ---------- קליטת דוחות עלות + ניתוב (צעד 3) ---------- */
export type RouteTarget = { id: number; label: string; authorityName: string | null };
export type DeptRow = { dept: string; workers: number; cost: number; hours: number; proposedReportId: number | null; learned?: boolean };
export type CostFile = {
  id: number; filename: string; software: string | null; sheetsUsed: string[];
  rowCount: number; routed: boolean; routedRows?: number; payer?: string | null; created_at?: string;
};
export const setCostFilePayer = (fileId: number, payer: string | null) =>
  api.put(`/cost-files/${fileId}/payer`, { payer }).then((r) => r.data);
export const setLedgerFilePayer = (fileId: number, payer: string | null) =>
  api.put(`/ledger-files/${fileId}/payer`, { payer }).then((r) => r.data);
export type RoutingResponse = { file: CostFile; departments: DeptRow[]; reports: RouteTarget[] };

export const uploadCostFile = async (clientId: number, file: File): Promise<RoutingResponse> => {
  await wakeServer();
  const fd = new FormData();
  fd.append('file', file);
  return api.post(`/clients/${clientId}/cost-files`, fd).then((r) => r.data);
};
export const getCostFileRouting = (fileId: number): Promise<RoutingResponse> =>
  api.get(`/cost-files/${fileId}`).then((r) => r.data);
export const routeCostFile = (fileId: number, routing: Record<string, number | null>) =>
  api.post(`/cost-files/${fileId}/route`, { routing }).then((r) => r.data);
export const listCostFiles = (clientId: number): Promise<CostFile[]> =>
  api.get(`/clients/${clientId}/cost-files`).then((r) => r.data);
export const deleteCostFile = (fileId: number) => api.delete(`/cost-files/${fileId}`).then((r) => r.data);
export const getReportCosts = (reportId: number) => api.get(`/reports/${reportId}/costs`).then((r) => r.data);

/* ---------- מנוע התקציב (צעד 4) ---------- */
export const uploadBudgetFile = async (reportId: number, file: File) => {
  await wakeServer();
  const fd = new FormData();
  fd.append('file', file);
  return api.post(`/reports/${reportId}/budget-file`, fd).then((r) => r.data);
};
export const getReportBudget = (reportId: number) => api.get(`/reports/${reportId}/budget`).then((r) => r.data);

/* ---------- הכנת דוח הביצוע וייצוא (צעד 9) ---------- */
export type PrepRow = {
  rowId: number; empId: string; name: string | null; firstName: string | null; lastName: string | null;
  dept: string; symbol: string | null; staffType: string | null; role: string | null; saved: boolean;
  gross: number | null; cost: number | null; hours: number | null; hourlyGross: number | null; hourlyCost: number | null;
};
export type StaffType = { type: string; roles: string[] };
export type SalaryItem = { type: string; label: string; budget: number; actual: number; over: number; under: number };
export type SalaryCheck = {
  items: SalaryItem[]; flexBudget: number; flexUsedForSalary: number; flexRemaining: number;
  overflow: number; unfunded: number; alerts: { level: 'warn' | 'err'; text: string }[]; hasBudget: boolean;
};
export type Move = { rowId: number; name: string; cost: number; from: string; fromName: string; to: string; toName: string; reduces: number };
export type Recommendations = {
  relevant: boolean; reason?: string; unassigned?: number;
  perInst?: { symbol: string; name: string; cap: number; actual: number; over: number; slack: number }[];
  moves?: Move[]; overflowBefore?: number; overflowAfter?: number; recovered?: number;
};
export type PrepData = {
  rows: PrepRow[]; institutions: { symbol: string; name: string }[]; staffTypes: StaffType[];
  employer: string; hasBudgetFile: boolean; budgetFileName: string | null;
  salary: SalaryCheck; framework: string; recommendations: Recommendations;
};
export type Assignment = { symbol: string | null; staffType: string | null; role: string | null };
export const getReportPrep = (reportId: number): Promise<PrepData> =>
  api.get(`/reports/${reportId}/prep`).then((r) => r.data);
export const saveReportPrep = (reportId: number, assignments: Record<string, Assignment>) =>
  api.put(`/reports/${reportId}/prep`, { assignments }).then((r) => r.data);
export const exportReportUrl = (reportId: number) => `${API_BASE}/reports/${reportId}/export`;

/* ---------- כרטסות + התאמה (צעד 6) ---------- */
export type LedgerCard = {
  id: number; ledger_file_id: number; card_key: string; card_name: string;
  debit: number; credit: number; net: number; basket_type: string | null;
};
export type LedgerCheck = { id: string; level: 'ok' | 'warn' | 'err'; text: string; a: number; b: number; diff: number };
export type LedgerData = {
  files: { id: number; filename: string; card_count: number; payer?: string | null; created_at: string }[];
  cards: LedgerCard[];
  basketOptions: { value: string; label: string }[];
  hasVat: boolean;
  reconcile: {
    hasLedger: boolean;
    byBasket?: { type: string; label: string; amount: number }[];
    unassigned?: number; ledgerSalary?: number; costTotal?: number;
    execActual?: number; expectedExec?: number; hasVat?: boolean;
    checks?: LedgerCheck[];
  };
};
export const uploadLedgerFile = async (reportId: number, file: File) => {
  await wakeServer();
  const fd = new FormData();
  fd.append('file', file);
  return api.post(`/reports/${reportId}/ledger-file`, fd).then((r) => r.data);
};
export const getReportLedger = (reportId: number): Promise<LedgerData> =>
  api.get(`/reports/${reportId}/ledger`).then((r) => r.data);
export const setLedgerCardBasket = (cardId: number, basket_type: string | null) =>
  api.put(`/ledger-cards/${cardId}`, { basket_type }).then((r) => r.data);
export const deleteLedgerFile = (fileId: number) => api.delete(`/ledger-files/${fileId}`).then((r) => r.data);

/* ---------- מסמך שלב 1 + החלטת לקוח על ניוד ---------- */
export const stage1DocUrl = (reportId: number) => `${API_BASE}/reports/${reportId}/stage1-doc`;
export const applyMove = (reportId: number, rowId: number, decision: 'move' | 'decline', toSymbol?: string) =>
  api.post(`/reports/${reportId}/apply-move`, { rowId, decision, toSymbol }).then((r) => r.data);

export default api;
