// Staff interface in English and Armenian (PRD 13.7). Public pages also have Russian.
const dict = {
  en: {
    overview: 'Overview', analytics: 'Analytics', cohorts: 'Cohorts', costs: 'Costs', links: 'Campaigns & links', health: 'Data health', traffic: 'Traffic',
    audience: 'Audience', contacts: 'Contacts', segments: 'Segments', import: 'Import', duplicates: 'Duplicates', audienceStats: 'Audience health',
    email: 'Email', campaigns: 'Campaign emails', newsletter: 'Newsletter', events: 'Events', emailSettings: 'Email settings', outbox: 'Dev inbox',
    admin: 'Admin', alerts: 'Alerts', audit: 'Activity log', signOut: 'Sign out', grpMeasure: 'Measure', grpReach: 'Reach', grpSend: 'Send', grpSettings: 'Settings',
    killOn: 'All sending is paused (kill switch is on).',
  },
  hy: {
    overview: 'Ամփոփում', analytics: 'Վերլուծություն', cohorts: 'Կոհորտներ', costs: 'Ծախսեր', links: 'Արշավներ և հղումներ', health: 'Տվյալների վիճակ', traffic: 'Այցելություններ',
    audience: 'Լսարան', contacts: 'Կոնտակտներ', segments: 'Սեգմենտներ', import: 'Ներմուծում', duplicates: 'Կրկնօրինակներ', audienceStats: 'Լսարանի վիճակ',
    email: 'Էլ. փոստ', campaigns: 'Արշավային նամակներ', newsletter: 'Տեղեկագիր', events: 'Միջոցառումներ', emailSettings: 'Փոստի կարգավորումներ', outbox: 'Թեստային փոստարկղ',
    admin: 'Ադմինիստրացիա', alerts: 'Ծանուցումներ', audit: 'Գործողությունների մատյան', signOut: 'Ելք', grpMeasure: 'Չափում', grpReach: 'Լսարան', grpSend: 'Առաքում', grpSettings: 'Կարգավորումներ',
    killOn: 'Բոլոր առաքումները դադարեցված են։',
  },
};
export function t(lang, key) { return dict[lang]?.[key] ?? dict.en[key] ?? key; }
