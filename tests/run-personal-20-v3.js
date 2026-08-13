const personalModule = require("../personal-call-overrides");
const { PERSONAL_CALL_HARD_STOPS } = require("../personal-call-hard-stops");
personalModule.PERSONAL_CALL_OVERRIDES += PERSONAL_CALL_HARD_STOPS;
require("./run-personal-20-v2");
