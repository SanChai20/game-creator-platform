// The Worker's own pages (the agent consent screen at /authorize and its error pages) in the six web app languages.
// The language is the one picked in the web app (the gcp_lang cookie), else the browser's Accept-Language.
import { detectLang, isLang, langTag, type Lang } from '../web/src/i18n/langs';

export function pageLang(req: Request): Lang {
  const c = (req.headers.get('cookie') || '').match(/(?:^|;\s*)gcp_lang=([^;]+)/)?.[1];
  const v = c ? decodeURIComponent(c) : '';
  return isLang(v) ? v : detectLang(req.headers.get('accept-language'));
}
export { langTag };

type Text = {
  connect: (app: string) => string; heading: (app: string) => string;
  publishedBy: (domain: string) => string; unverified: string; sentTo: (host: string) => string;
  loopback: [string, string]; signedInAs: (name: string, email: string) => string;
  can: [string, string, string, string]; cannot: string; webOnly: string; deny: string; allow: string;
  expires: (days: number) => string;
  signInAgain: string; sessionEnded: string; sessionEndedBody: string;
  cannotConnect: string; cannotContinue: string; startAgain: string; notVerified: string;
  // Project-level authorization scope
  scopeHeading: string;
  scopeAll: string; scopeAllHint: string;
  scopeSelected: string; scopeSelectedHint: string;
  scopeSearch: string; scopeSelectAll: string; scopeClear: string;
  scopeSelectedCount: (n: number) => string;
  scopePickOne: string;
  scopeNoProjects: string;
  scopePrev: string; scopeNext: string;
  statusLabels: Record<string, string>;
};

// Strings take HTML-escaped arguments; the <strong> markup is part of each sentence so word order can change.
export const TEXT: Record<Lang, Text> = {
  en: {
    connect: (a) => `Connect ${a}`, heading: (a) => `Let ${a} publish web games for you?`,
    publishedBy: (d) => `Published by <strong>${d}</strong>.`, unverified: 'This app registered itself, so its name is not verified.',
    sentTo: (h) => `Access will be sent to <strong>${h}</strong>.`,
    loopback: ['This sends access to an app on your computer.', 'Continue only if you just started connecting from that app.'],
    signedInAs: (n, e) => `Signed in as <strong>${n}</strong> (${e}). The agent will be able to:`,
    can: ['Create your game projects and upload their files', 'Deploy previews and run verification', 'Publish, roll back and take games offline', 'Set listing details and prices, and read your game stats'],
    cannot: 'It cannot withdraw money, change your password or see payment details.',
    webOnly: 'This platform hosts web games only: games that run in a browser page. Native, mobile, console and desktop builds are refused.',
    deny: 'Deny', allow: 'Allow',
    expires: (d) => `Access expires after ${d} day${d === 1 ? '' : 's'}; you can revoke it sooner from your console.`,
    signInAgain: 'Sign in again', sessionEnded: 'Your session ended', sessionEndedBody: 'Sign in and start connecting from your agent again.',
    cannotConnect: 'Cannot connect', cannotContinue: 'This connection cannot continue', startAgain: 'Start connecting from your agent again.', notVerified: 'This app could not be verified.',
    scopeHeading: 'Which projects can this agent access?',
    scopeAll: 'All projects (including new ones)',
    scopeAllHint: 'Can access every project in your account and create new projects.',
    scopeSelected: 'Only selected projects',
    scopeSelectedHint: 'Can only access the projects you tick below. Cannot see other projects or create new ones.',
    scopeSearch: 'Filter projects…', scopeSelectAll: 'Select all', scopeClear: 'Clear',
    scopeSelectedCount: (n) => `${n} selected`,
    scopePickOne: 'Select at least one project to continue.',
    scopeNoProjects: 'You do not have any projects yet, so this agent will have access to all projects you create.',
    scopePrev: 'Prev', scopeNext: 'Next',
    statusLabels: { live: 'Live', draft: 'Draft', offline: 'Offline' },
  },
  zh: {
    connect: (a) => `连接 ${a}`, heading: (a) => `允许 ${a} 为你发布网页游戏吗？`,
    publishedBy: (d) => `发布者：<strong>${d}</strong>。`, unverified: '这个应用是自行注册的，其名称未经验证。',
    sentTo: (h) => `访问权限将发送至 <strong>${h}</strong>。`,
    loopback: ['这会把访问权限发送给你电脑上的一个应用。', '只有当你刚刚从那个应用发起连接时才继续。'],
    signedInAs: (n, e) => `当前登录账户：<strong>${n}</strong>（${e}）。该智能体将可以：`,
    can: ['创建你的游戏项目并上传文件', '部署预览并运行验证', '发布、回滚与下线游戏', '设置上架信息与价格，查看游戏数据'],
    cannot: '它无法提现、修改密码或查看支付信息。',
    webOnly: '本平台仅托管网页游戏，即在浏览器页面中运行的游戏。原生、移动端、主机和桌面端构建会被拒绝。',
    deny: '拒绝', allow: '允许',
    expires: (d) => `访问权限将在 ${d} 天后过期，你也可以随时在控制台提前撤销。`,
    signInAgain: '请重新登录', sessionEnded: '你的登录已过期', sessionEndedBody: '请登录后，从你的智能体重新发起连接。',
    cannotConnect: '无法连接', cannotContinue: '此连接无法继续', startAgain: '请从你的智能体重新发起连接。', notVerified: '无法验证这个应用。',
    scopeHeading: '授权范围：允许该智能体访问哪些项目？',
    scopeAll: '全部项目（包括之后新建的项目）',
    scopeAllHint: '可访问账户下的全部项目，并可创建新项目。',
    scopeSelected: '仅限指定项目',
    scopeSelectedHint: '仅可访问下方勾选的项目，无法查看其他项目或创建新项目。',
    scopeSearch: '搜索项目…', scopeSelectAll: '全选', scopeClear: '清空',
    scopeSelectedCount: (n) => `已选 ${n} 个`,
    scopePickOne: '请至少选择一个项目后再继续。',
    scopeNoProjects: '你目前还没有项目，该智能体将拥有你之后创建的所有项目的访问权限。',
    scopePrev: '上一页', scopeNext: '下一页',
    statusLabels: { live: '已上线', draft: '草稿', offline: '已下线' },
  },
  'zh-TW': {
    connect: (a) => `連接 ${a}`, heading: (a) => `允許 ${a} 為你發布網頁遊戲嗎？`,
    publishedBy: (d) => `發布者：<strong>${d}</strong>。`, unverified: '這個應用程式是自行註冊的，名稱未經驗證。',
    sentTo: (h) => `存取權限將傳送至 <strong>${h}</strong>。`,
    loopback: ['這會把存取權限傳送給你電腦上的一個應用程式。', '只有當你剛剛從那個應用程式發起連接時才繼續。'],
    signedInAs: (n, e) => `目前登入帳戶：<strong>${n}</strong>（${e}）。這個 AI 代理將可以：`,
    can: ['建立你的遊戲專案並上傳檔案', '部署預覽並執行驗證', '發布、回溯與下架遊戲', '設定上架資訊與價格，查看遊戲資料'],
    cannot: '它無法提領、修改密碼或查看付款資訊。',
    webOnly: '本平台僅託管網頁遊戲，即在瀏覽器頁面中執行的遊戲。原生、行動裝置、主機和桌面版建置會被拒絕。',
    deny: '拒絕', allow: '允許',
    expires: (d) => `存取權限將在 ${d} 天後過期，你也可以隨時在主控台提前撤銷。`,
    signInAgain: '請重新登入', sessionEnded: '你的登入已過期', sessionEndedBody: '請登入後，從你的 AI 代理重新發起連接。',
    cannotConnect: '無法連接', cannotContinue: '此連接無法繼續', startAgain: '請從你的 AI 代理重新發起連接。', notVerified: '無法驗證這個應用程式。',
    scopeHeading: '授權範圍：允許這個 AI 代理存取哪些專案？',
    scopeAll: '全部專案（包括之後新建的專案）',
    scopeAllHint: '可存取帳戶下的所有專案，並可建立新專案。',
    scopeSelected: '僅限指定專案',
    scopeSelectedHint: '僅可存取下方勾選的專案，無法查看其他專案或建立新專案。',
    scopeSearch: '篩選專案…', scopeSelectAll: '全選', scopeClear: '清除',
    scopeSelectedCount: (n) => `已選 ${n} 個`,
    scopePickOne: '請至少選擇一個專案以繼續。',
    scopeNoProjects: '你目前還沒有專案，此 AI 代理將可存取你之後建立的所有專案。',
    scopePrev: '上一頁', scopeNext: '下一頁',
    statusLabels: { live: '已上線', draft: '草稿', offline: '已下架' },
  },
  ja: {
    connect: (a) => `${a} を接続`, heading: (a) => `${a} にWebゲームの公開を許可しますか？`,
    publishedBy: (d) => `提供元：<strong>${d}</strong>。`, unverified: 'このアプリは自己登録されたため、名前は検証されていません。',
    sentTo: (h) => `アクセス権は <strong>${h}</strong> に送られます。`,
    loopback: ['これはあなたのコンピューター上のアプリにアクセス権を送ります。', 'そのアプリから接続を始めたばかりの場合にのみ続けてください。'],
    signedInAs: (n, e) => `<strong>${n}</strong>（${e}）としてログイン中です。エージェントは次のことができるようになります：`,
    can: ['ゲームプロジェクトの作成とファイルのアップロード', 'プレビューのデプロイと検証の実行', 'ゲームの公開、ロールバック、非公開化', '掲載情報と価格の設定、ゲームの統計の閲覧'],
    cannot: 'お金の出金、パスワードの変更、支払い情報の閲覧はできません。',
    webOnly: 'このプラットフォームはWebゲーム（ブラウザのページで動くゲーム）のみをホストします。ネイティブ、モバイル、コンソール、デスクトップ向けのビルドは拒否されます。',
    deny: '拒否', allow: '許可',
    expires: (d) => `アクセスは ${d} 日後に期限切れになります。それより前にコンソールから取り消すこともできます。`,
    signInAgain: 'もう一度ログイン', sessionEnded: 'セッションが終了しました', sessionEndedBody: 'ログインして、エージェントからもう一度接続を始めてください。',
    cannotConnect: '接続できません', cannotContinue: 'この接続は続行できません', startAgain: 'エージェントからもう一度接続を始めてください。', notVerified: 'このアプリを検証できませんでした。',
    scopeHeading: 'このエージェントにアクセスを許可するプロジェクト',
    scopeAll: 'すべてのプロジェクト（今後作成するものを含む）',
    scopeAllHint: 'アカウント内のすべてのプロジェクトにアクセスし、新しいプロジェクトを作成できます。',
    scopeSelected: '選択したプロジェクトのみ',
    scopeSelectedHint: '下でチェックしたプロジェクトのみアクセスできます。他のプロジェクトの閲覧や新規作成はできません。',
    scopeSearch: 'プロジェクトを検索…', scopeSelectAll: 'すべて選択', scopeClear: 'クリア',
    scopeSelectedCount: (n) => `${n} 件選択中`,
    scopePickOne: '続行するにはプロジェクトを1つ以上選択してください。',
    scopeNoProjects: 'まだプロジェクトがないため、今後作成するすべてのプロジェクトにアクセスできます。',
    scopePrev: '前へ', scopeNext: '次へ',
    statusLabels: { live: '公開中', draft: '下書き', offline: '非公開' },
  },
  ko: {
    connect: (a) => `${a} 연결`, heading: (a) => `${a}이(가) 웹 게임을 게시하도록 허용할까요?`,
    publishedBy: (d) => `게시자: <strong>${d}</strong>.`, unverified: '이 앱은 스스로 등록했기 때문에 이름이 확인되지 않았습니다.',
    sentTo: (h) => `접근 권한은 <strong>${h}</strong>(으)로 전송됩니다.`,
    loopback: ['이 작업은 내 컴퓨터의 앱에 접근 권한을 보냅니다.', '방금 그 앱에서 연결을 시작한 경우에만 계속하세요.'],
    signedInAs: (n, e) => `<strong>${n}</strong>(${e}) 계정으로 로그인되어 있습니다. 에이전트는 다음을 할 수 있습니다:`,
    can: ['게임 프로젝트 만들기 및 파일 업로드', '프리뷰 배포 및 검증 실행', '게임 게시, 롤백, 비공개 전환', '등록 정보와 가격 설정, 게임 통계 보기'],
    cannot: '출금, 비밀번호 변경, 결제 정보 보기는 할 수 없습니다.',
    webOnly: '이 플랫폼은 웹 게임(브라우저 페이지에서 실행되는 게임)만 호스팅합니다. 네이티브, 모바일, 콘솔, 데스크톱 빌드는 거부됩니다.',
    deny: '거부', allow: '허용',
    expires: (d) => `접근 권한은 ${d}일 후 만료됩니다. 그 전에 콘솔에서 취소할 수도 있습니다.`,
    signInAgain: '다시 로그인', sessionEnded: '세션이 종료되었습니다', sessionEndedBody: '로그인한 뒤 에이전트에서 다시 연결을 시작하세요.',
    cannotConnect: '연결할 수 없음', cannotContinue: '이 연결은 계속할 수 없습니다', startAgain: '에이전트에서 다시 연결을 시작하세요.', notVerified: '이 앱을 확인할 수 없습니다.',
    scopeHeading: '이 에이전트가 접근할 수 있는 프로젝트',
    scopeAll: '모든 프로젝트(새로 만들 프로젝트 포함)',
    scopeAllHint: '계정의 모든 프로젝트에 접근하고 새 프로젝트를 만들 수 있습니다.',
    scopeSelected: '선택한 프로젝트만',
    scopeSelectedHint: '아래에서 선택한 프로젝트에만 접근할 수 있으며, 다른 프로젝트 조회나 새 프로젝트 생성은 할 수 없습니다.',
    scopeSearch: '프로젝트 검색…', scopeSelectAll: '모두 선택', scopeClear: '선택 해제',
    scopeSelectedCount: (n) => `${n}개 선택됨`,
    scopePickOne: '계속하려면 프로젝트를 하나 이상 선택하세요.',
    scopeNoProjects: '아직 프로젝트가 없으므로 앞으로 만드는 모든 프로젝트에 접근할 수 있습니다.',
    scopePrev: '이전', scopeNext: '다음',
    statusLabels: { live: '게시됨', draft: '초안', offline: '비공개' },
  },
  es: {
    connect: (a) => `Conectar ${a}`, heading: (a) => `¿Permitir que ${a} publique juegos web por ti?`,
    publishedBy: (d) => `Publicada por <strong>${d}</strong>.`, unverified: 'Esta app se registró sola, así que su nombre no está verificado.',
    sentTo: (h) => `El acceso se enviará a <strong>${h}</strong>.`,
    loopback: ['Esto envía el acceso a una app de tu ordenador.', 'Continúa solo si acabas de empezar a conectar desde esa app.'],
    signedInAs: (n, e) => `Sesión iniciada como <strong>${n}</strong> (${e}). El agente podrá:`,
    can: ['Crear tus proyectos de juego y subir sus archivos', 'Desplegar vistas previas y ejecutar la verificación', 'Publicar, revertir y desconectar juegos', 'Configurar la ficha y los precios, y leer las estadísticas de tus juegos'],
    cannot: 'No puede retirar dinero, cambiar tu contraseña ni ver datos de pago.',
    webOnly: 'Esta plataforma solo aloja juegos web: juegos que se ejecutan en una página del navegador. Se rechazan las compilaciones nativas, móviles, de consola y de escritorio.',
    deny: 'Denegar', allow: 'Permitir',
    expires: (d) => `El acceso caduca en ${d} día${d === 1 ? '' : 's'}; puedes revocarlo antes desde tu consola.`,
    signInAgain: 'Vuelve a iniciar sesión', sessionEnded: 'Tu sesión ha terminado', sessionEndedBody: 'Inicia sesión y vuelve a conectar desde tu agente.',
    cannotConnect: 'No se puede conectar', cannotContinue: 'Esta conexión no puede continuar', startAgain: 'Vuelve a conectar desde tu agente.', notVerified: 'No se pudo verificar esta app.',
    scopeHeading: '¿A qué proyectos puede acceder este agente?',
    scopeAll: 'Todos los proyectos (incluidos los nuevos)',
    scopeAllHint: 'Puede acceder a todos los proyectos de tu cuenta y crear proyectos nuevos.',
    scopeSelected: 'Solo proyectos seleccionados',
    scopeSelectedHint: 'Solo puede acceder a los proyectos que marques abajo. No puede ver otros proyectos ni crear nuevos.',
    scopeSearch: 'Filtrar proyectos…', scopeSelectAll: 'Seleccionar todo', scopeClear: 'Limpiar',
    scopeSelectedCount: (n) => `${n} seleccionado${n === 1 ? '' : 's'}`,
    scopePickOne: 'Selecciona al menos un proyecto para continuar.',
    scopeNoProjects: 'Todavía no tienes proyectos, así que este agente tendrá acceso a todos los que crees.',
    scopePrev: 'Ant.', scopeNext: 'Sig.',
    statusLabels: { live: 'Publicado', draft: 'Borrador', offline: 'Desconectado' },
  },
};
