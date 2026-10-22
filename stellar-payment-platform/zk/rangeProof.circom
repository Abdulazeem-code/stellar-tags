pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";

template RangeProof(bits) {
    signal input amount;
    signal input blinding;
    signal input maxLimit;
    signal output commitment;

    component amountBits = Num2Bits(bits);
    amountBits.in <== amount;

    component limitBits = Num2Bits(bits);
    limitBits.in <== maxLimit;

    component positive = GreaterThan(bits);
    positive.in[0] <== amount;
    positive.in[1] <== 0;
    positive.out === 1;

    component withinLimit = LessThan(bits);
    withinLimit.in[0] <== amount;
    withinLimit.in[1] <== maxLimit;
    withinLimit.out === 1;

    component hash = Poseidon(2);
    hash.inputs[0] <== amount;
    hash.inputs[1] <== blinding;
    commitment <== hash.out;
}

component main {public [maxLimit]} = RangeProof(64);
