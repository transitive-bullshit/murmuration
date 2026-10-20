// English stopwords (sklearn-style, minus words that carry meaning in a dev /
// AI corpus such as "system", "call", "full", "side") plus apostrophe-free
// contractions and Twitter chatter. Matched after lowercasing and stripping
// apostrophes, so "don't" arrives here as "dont".
const ENGLISH = `
a about above across after afterwards again against all almost alone along already also although always am among
amongst an and another any anyhow anyone anything anyway anyways anywhere are around as at be became because become
becomes becoming been before beforehand behind being below beside besides between beyond both but by can cannot
could de do does doing done down due during each eg either else elsewhere enough etc even ever every everyone
everything everywhere except few for former formerly from further had has have having he hence her here hereafter
hereby herein hereupon hers herself him himself his how however ie if in inc indeed into is it its itself last latter
latterly least less ltd many may me meanwhile might mine more moreover most mostly much must my myself namely neither
never nevertheless no nobody none noone nor not nothing now nowhere of off often on once one only onto or other others
otherwise our ours ourselves out over own per perhaps please rather re same seem seemed seeming seems several she
should since so some somehow someone something sometime sometimes somewhere still such than that the their theirs
them themselves then thence there thereafter thereby therefore therein thereupon these they this those though through
throughout thru thus to together too toward towards un under until up upon us very via was we were what whatever when
whence whenever where whereafter whereas whereby wherein whereupon wherever whether which while whither who whoever
whole whom whose why will with within without would yet you your yours yourself yourselves
`

const NUMBERS = `
two three four five six seven eight nine ten eleven twelve fifteen twenty thirty forty fifty sixty hundred thousand
million billion first second third fourth fifth half
`

const CONTRACTIONS = `
dont doesnt didnt isnt arent wasnt werent wont wouldnt shouldnt couldnt cant aint havent hasnt hadnt mustnt neednt
im ive id ill youre youve youd youll hes shes theyre theyve theyd theyll weve wed lets thats whats theres heres
wheres hows whos whys yall ya youse gonna wanna gotta gimme lemme kinda sorta dunno
`

const CHATTER = `
rt via amp lol lmao lmfao rofl haha hahaha hahahaha hehe heh yeah yea yes yep yup nope nah ok okay oh ohh ooh hey hi
hello wow omg omfg wtf smh tbh imo imho idk idc ikr fyi btw afaik iirc irl tho thx ty tysm pls plz u ur r yo ya
just like likes liked really thanks thank thanked aww awww ugh hmm hmmm umm uh um woah whoa yay oops dm dms
retweet retweets tweet tweets tweeted tweeting thread threads reply replies replying follow followers following
get gets got getting gotten go goes going gone went come comes coming came make makes making made know knows knew
known think thinks thinking thought want wants wanted need needs needed say says said saying see sees seeing seen saw
look looks looking looked use uses using used try tries trying tried let feel feels felt give gives gave given take
takes took taken keep keeps kept put puts find finds found tell tells told ask asks asked mean means meant seems
good great nice cool awesome amazing best better bad big little lot lots new old sure maybe probably actually literally
definitely totally basically pretty super quite right real true thing things stuff people guy guys man dude bro
way ways day days today tonight tomorrow yesterday time times year years week weeks month months ago soon
always gonna someday anyways else ever every honestly seriously absolutely exactly simply especially truly
love loved loving lovely hate excited glad happy fun funny wait yall wish hope hoping
did well next back long high low start started starting starts help helps helped helping hard harder agreed agree
bit part parts end ends turn turns change changed changes ready hours minutes seconds insane crazy incredible perfect
beautiful brilliant interesting favorite fav appreciate appreciated share shares shared sharing check checking talk
talks talking question questions answer reminds remind happen happens happened different entire extremely deserved
wonderful fantastic excellent special huge tiny small easy easier simple quick quickly early late later recently
recent currently current finally nearly kind sort able point points place places instead based important level single
possible far set case away hit left moment forward reason similar step imagine believe understand worth stop past
thoughts called created add available useful vs work works worked working post posts posted posting learnmore
show shows showing showed run runs view views top full yesterday whats ones lol damn hell fuck fucking shit holy
sounds sound def
dope af luck proud related specific curious sorry ah uh
`

export const STOPWORDS: ReadonlySet<string> = new Set(
  [ENGLISH, NUMBERS, CONTRACTIONS, CHATTER]
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
)
