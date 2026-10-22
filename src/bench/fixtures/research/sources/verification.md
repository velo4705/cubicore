# On what a check can prove

A check proves a specific thing or it proves nothing. "The tests pass" is a
claim about a specific set of inputs. It is not a claim about correctness, and
it is not a claim about the parts of the system nobody wrote a test for.

The useful question is not "is this good" but "what did someone measure, and
what would a failure here look like". A check whose failure mode you cannot
describe is not a check.
