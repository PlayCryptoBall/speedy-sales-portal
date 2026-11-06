select (select count(*) from companies) companies, (select count(*) from contacts) contacts, (select count(*) from projects) projects,
 (select count(*) from opportunities) opps, (select count(*) from opportunity_projects) links, (select count(*) from activities) activities,
 (select count(*) from opportunities where kind='gov_bid') gov, (select count(*) from opportunities where kind<>'gov_bid') leads;
