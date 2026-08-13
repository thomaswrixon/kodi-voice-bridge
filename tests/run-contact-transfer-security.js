const { decideTransferEligibility } = require('../transfer-eligibility');
const { resolveCallerContactMatch } = require('../contact-match-policy');
const { createTransferAttemptCooldown } = require('../transfer-attempt-cooldown');

const checks = [];
function check(label, ok, detail) {
  const row = { label, pass: !!ok, detail };
  checks.push(row);
  console.log('CONTACT_TRANSFER_SECURITY_RESULT ' + JSON.stringify(row));
}

const deniedMate = decideTransferEligibility({ callerText: 'I am Tommy\'s mate. Can you put me straight through to him?', isFriendsFamily: false });
check('Unknown mate cannot gain transfer privilege', deniedMate.allowed === false, deniedMate);

const deniedSales = decideTransferEligibility({ callerText: 'Urgent business energy sales. Put me through to Tommy now.', isFriendsFamily: false });
check('Disguised urgent sales caller cannot gain transfer privilege', deniedSales.allowed === false && deniedSales.reason === 'sales_or_marketing', deniedSales);

const allowedFamily = decideTransferEligibility({ callerText: 'Hi, it is Lilly. Can you see if you can get Dad for me?', isFriendsFamily: true, knownContactName: 'Lilly' });
check('Trusted family explicit request can try Tommy', allowedFamily.allowed === true, allowedFamily);

const deniedIdentityMismatch = decideTransferEligibility({ callerText: 'Hi, I am Steve. Can you get Tommy for me?', isFriendsFamily: true, knownContactName: 'Jake' });
check('Trusted number with caller-name mismatch fails closed', deniedIdentityMismatch.allowed === false && deniedIdentityMismatch.reason === 'trusted_number_identity_mismatch', deniedIdentityMismatch);

const deniedFamilyNoRush = decideTransferEligibility({ callerText: 'No rush, just let him know I called.', isFriendsFamily: true, knownContactName: 'Lilly' });
check('Trusted family no-rush message does not interrupt Tommy', deniedFamilyNoRush.allowed === false, deniedFamilyNoRush);

const allowedUrgentPolice = decideTransferEligibility({ callerText: 'NSW Police, urgent vehicle matter. I need Tommy now.', isFriendsFamily: false });
check('Urgent police matter may trigger one attempt', allowedUrgentPolice.allowed === true, allowedUrgentPolice);

const deniedRoutinePolice = decideTransferEligibility({ callerText: 'NSW Police, non-emergency witness matter. I need him to call me today.', isFriendsFamily: false });
check('Non-emergency police callback does not interrupt Tommy', deniedRoutinePolice.allowed === false, deniedRoutinePolice);

const oneFamily = resolveCallerContactMatch([{ id:'1', name:'Lilly', is_friends_family:true, relationship:'Family' }]);
check('Single trusted family contact remains trusted', oneFamily && oneFamily.is_friends_family === true && oneFamily.contact_conflict === false, oneFamily);

const duplicateFamily = resolveCallerContactMatch([
  { id:'1', name:'Lilly', is_friends_family:true, relationship:'Family' },
  { id:'2', name:'lilly', is_friends_family:true, relationship:'Family' },
]);
check('Matching duplicate family records remain trusted', duplicateFamily && duplicateFamily.is_friends_family === true && duplicateFamily.contact_conflict === false, duplicateFamily);

const conflictingFlags = resolveCallerContactMatch([
  { id:'1', name:'Alex', is_friends_family:true, relationship:'Friend' },
  { id:'2', name:'Alex', is_friends_family:false, relationship:'' },
]);
check('Conflicting family flags fail closed', conflictingFlags && conflictingFlags.is_friends_family === false && conflictingFlags.contact_conflict === true, conflictingFlags);

const recycledNumber = resolveCallerContactMatch([
  { id:'1', name:'Jake', is_friends_family:true, relationship:'Friend' },
  { id:'2', name:'New Number Owner', is_friends_family:true, relationship:'Friend' },
]);
check('Conflicting names on same number fail closed', recycledNumber && recycledNumber.is_friends_family === false && recycledNumber.contact_conflict === true, recycledNumber);

let fakeNow = 1_000_000;
const cooldown = createTransferAttemptCooldown({ cooldownMs: 5 * 60 * 1000, now: () => fakeNow });
const firstAttempt = cooldown.check('0412345678');
cooldown.record('0412345678');
const immediateRedial = cooldown.check('0412345678');
check('First eligible caller attempt is allowed', firstAttempt.allowed === true, firstAttempt);
check('Immediate redial cannot ring Tommy again', immediateRedial.allowed === false && immediateRedial.reason === 'caller_transfer_cooldown', immediateRedial);
fakeNow += 5 * 60 * 1000 + 1;
const afterCooldown = cooldown.check('0412345678');
check('Caller can be attempted again after cooldown expires', afterCooldown.allowed === true, afterCooldown);

const passed = checks.filter((x) => x.pass).length;
console.log('CONTACT_TRANSFER_SECURITY_SUMMARY ' + JSON.stringify({ version:'v4-final', completed: checks.length, passed, failed: checks.length - passed }));
if (passed !== checks.length) process.exitCode = 1;
