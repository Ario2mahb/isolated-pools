import { smock } from "@defi-wonderland/smock";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { BigNumberish, Signer } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { convertToUnit } from "../../../helpers/utils";
import {
  AccessControlManager,
  AccessControlManager__factory,
  BinanceOracle,
  BinanceOracle__factory,
  Comptroller,
  Comptroller__factory,
  MockToken,
  MockToken__factory,
  RewardsDistributor,
  RewardsDistributor__factory,
  VToken,
  VToken__factory,
} from "../../../typechain";
import CONTRACT_ADDRESSES from "./constants/Contracts.json";
import { initMainnetUser, setForkBlock } from "./utils";

const { expect } = chai;
chai.use(smock.matchers);

const FORK_TESTNET = process.env.FORK_TESTNET === "true";
const FORK_MAINNET = process.env.FORK_MAINNET === "true";
const network = process.env.NETWORK_NAME;

const MANTISSA_ONE = convertToUnit(1, 18);

let BINANCE_ORACLE: string;

const ADMIN: string = CONTRACT_ADDRESSES[network as string].ADMIN;
const ACM: string = CONTRACT_ADDRESSES[network as string].ACM;
const acc1: string = CONTRACT_ADDRESSES[network as string].acc1;
const acc2: string = CONTRACT_ADDRESSES[network as string].acc2;
const TOKEN1: string = CONTRACT_ADDRESSES[network as string].HAY; // HAY
const COMPTROLLER: string = CONTRACT_ADDRESSES[network as string].COMPTROLLER;
const VTOKEN1: string = CONTRACT_ADDRESSES[network as string].VHAY; // VHAY
const REWARD_DISTRIBUTOR1: string = CONTRACT_ADDRESSES[network as string].REWARD_DISTRIBUTOR1;
const BLOCK_NUMBER: number = CONTRACT_ADDRESSES[network as string].BLOCK_NUMBER;

if (network == "bsctestnet") {
  BINANCE_ORACLE = CONTRACT_ADDRESSES[network as string].BINANCE_ORACLE;
}

let impersonatedTimelock: Signer;
let accessControlManager: AccessControlManager;
let comptroller: Comptroller;
let vTOKEN1: VToken;
let token1: MockToken;
let rewardDistributor1: RewardsDistributor;
let acc1Signer: Signer;
let acc2Signer: Signer;
let comptrollerSigner: Signer;
let mintAmount: BigNumberish;
let bswBorrowAmount: BigNumberish;
let binanceOracle: BinanceOracle;

async function configureTimelock() {
  impersonatedTimelock = await initMainnetUser(ADMIN, ethers.utils.parseUnits("2"));
}

async function configureVToken(vTokenAddress: string) {
  return VToken__factory.connect(vTokenAddress, impersonatedTimelock);
}

async function grantPermissions() {
  accessControlManager = AccessControlManager__factory.connect(ACM, impersonatedTimelock);

  let tx = await accessControlManager
    .connect(impersonatedTimelock)
    .giveCallPermission(comptroller.address, "setMarketSupplyCaps(address[],uint256[])", ADMIN);
  await tx.wait();

  tx = await accessControlManager
    .connect(impersonatedTimelock)
    .giveCallPermission(comptroller.address, "setMarketBorrowCaps(address[],uint256[])", ADMIN);
  await tx.wait();
}

if (FORK_TESTNET || FORK_MAINNET) {
  describe("Rewards distributions", async () => {
    mintAmount = convertToUnit("100000000", 18);
    bswBorrowAmount = convertToUnit("100", 18);

    async function setup() {
      await setForkBlock(BLOCK_NUMBER);
      await configureTimelock();

      acc1Signer = await initMainnetUser(acc1, ethers.utils.parseUnits("2"));
      acc2Signer = await initMainnetUser(acc2, ethers.utils.parseUnits("2"));
      comptrollerSigner = await initMainnetUser(COMPTROLLER, ethers.utils.parseUnits("2"));

      token1 = MockToken__factory.connect(TOKEN1, impersonatedTimelock);
      vTOKEN1 = await configureVToken(VTOKEN1);
      comptroller = Comptroller__factory.connect(COMPTROLLER, impersonatedTimelock);
      rewardDistributor1 = RewardsDistributor__factory.connect(REWARD_DISTRIBUTOR1, impersonatedTimelock);

      await grantPermissions();

      await comptroller.connect(acc1Signer).enterMarkets([vTOKEN1.address]);
      await comptroller.connect(acc2Signer).enterMarkets([vTOKEN1.address]);

      await comptroller.setMarketSupplyCaps([vTOKEN1.address], [convertToUnit(1, 50)]);
      await comptroller.setMarketBorrowCaps([vTOKEN1.address], [convertToUnit(1, 50)]);

      if (network == "bsctestnet") {
        binanceOracle = BinanceOracle__factory.connect(BINANCE_ORACLE, impersonatedTimelock);
        await binanceOracle.connect(impersonatedTimelock).setMaxStalePeriod("HAY", 31536000);
      }
    }

    async function mintVTokens(signer: Signer, token: MockToken, vToken: VToken, amount: BigNumberish) {
      await token.connect(signer).faucet(amount);
      await token.connect(signer).approve(vToken.address, amount);
      await expect(vToken.connect(signer).mint(amount)).to.emit(vToken, "Mint");
    }

    async function computeSupplyRewards(
      rewardDistributor: RewardsDistributor,
      vTokenAddress: string,
      vToken: VToken,
      user: string,
    ) {
      const supplierAccruedOld = await rewardDistributor.rewardTokenAccrued(user);
      await rewardDistributor.connect(comptrollerSigner).updateRewardTokenSupplyIndex(vTokenAddress);

      const supplyState = await rewardDistributor.rewardTokenSupplyState(vTokenAddress);
      const supplyIndex = supplyState.index;
      let supplierIndex = await rewardDistributor.rewardTokenSupplierIndex(vTokenAddress, user);

      if (supplierIndex == parseUnits("0") && supplyIndex >= parseUnits("1", 36)) {
        supplierIndex = parseUnits("1", 36);
      }

      const deltaIndex = supplyIndex.sub(supplierIndex).div(MANTISSA_ONE);
      const supplierTokens = await vToken.balanceOf(user);
      const supplierDelta = supplierTokens.mul(deltaIndex).div(MANTISSA_ONE);
      const supplierAccruedExpected = supplierAccruedOld.add(supplierDelta);
      await rewardDistributor.connect(comptrollerSigner).distributeSupplierRewardToken(vTokenAddress, user);
      return supplierAccruedExpected;
    }

    async function computeBorrowRewards(
      rewardDistributor: RewardsDistributor,
      vTokenAddress: string,
      vToken: VToken,
      user: string,
    ) {
      await vTOKEN1.accrueInterest();
      const marketBorrowIndex = await vToken.borrowIndex();
      const borrowerAccruedOld = await rewardDistributor.rewardTokenAccrued(user);

      await rewardDistributor
        .connect(comptrollerSigner)
        .updateRewardTokenBorrowIndex(vTokenAddress, { mantissa: marketBorrowIndex });

      const borrowState = await rewardDistributor.rewardTokenBorrowState(vTokenAddress);
      const borrowIndex = borrowState.index;
      let borrowerIndex = await rewardDistributor.rewardTokenBorrowerIndex(vTokenAddress, user);

      if (borrowerIndex == parseUnits("0") && borrowIndex >= parseUnits("1", 36)) {
        borrowerIndex = parseUnits("1", 36);
      }

      const deltaIndex = borrowIndex.sub(borrowerIndex).div(MANTISSA_ONE);
      const borrowerTokens = await vToken.borrowBalanceStored(user);
      const borrowBalance = borrowerTokens.mul(MANTISSA_ONE).div(marketBorrowIndex);
      const borrowerDelta = borrowBalance.mul(deltaIndex).div(MANTISSA_ONE);
      const borrowerAccruedExpected = borrowerAccruedOld.add(borrowerDelta);

      await rewardDistributor
        .connect(comptrollerSigner)
        .distributeBorrowerRewardToken(vTokenAddress, user, { mantissa: marketBorrowIndex });
      return borrowerAccruedExpected;
    }

    beforeEach(async () => {
      await setup();
    });

    it("Rewards for suppliers", async function () {
      await mintVTokens(acc1Signer, token1, vTOKEN1, mintAmount);
      await mine(3000000);
      await vTOKEN1.accrueInterest();

      // Reward1 calculations for user 1
      let supplierAccruedExpected = await computeSupplyRewards(rewardDistributor1, VTOKEN1, vTOKEN1, acc1);
      let supplierAccruedCurrent = await rewardDistributor1.rewardTokenAccrued(acc1);
      expect(supplierAccruedExpected).equals(supplierAccruedCurrent);

      // Transfer vTokens to user 2 from user 1
      const acc1Balance = await vTOKEN1.balanceOf(acc1);
      await vTOKEN1.connect(acc1Signer).transfer(acc2, acc1Balance);
      await vTOKEN1.accrueInterest();

      // Reward1 calculations for user 1
      supplierAccruedExpected = await computeSupplyRewards(rewardDistributor1, VTOKEN1, vTOKEN1, acc1);
      supplierAccruedCurrent = await rewardDistributor1.rewardTokenAccrued(acc1);
      expect(supplierAccruedExpected).equals(supplierAccruedCurrent);

      // Reward1 calculations for user 2
      supplierAccruedExpected = await computeSupplyRewards(rewardDistributor1, VTOKEN1, vTOKEN1, acc2);
      supplierAccruedCurrent = await rewardDistributor1.rewardTokenAccrued(acc2);
      expect(supplierAccruedExpected).equals(supplierAccruedCurrent);
    });
    it("Rewards for borrowers", async function () {
      await mintVTokens(acc1Signer, token1, vTOKEN1, mintAmount);
      await vTOKEN1.connect(acc1Signer).borrow(bswBorrowAmount);
      await mine(3000000);
      await vTOKEN1.accrueInterest();

      // Reward1 calculations for user 1
      let borrowerAccruedExpected = await computeBorrowRewards(rewardDistributor1, VTOKEN1, vTOKEN1, acc1);
      let borrowerAccruedCurrent = await rewardDistributor1.rewardTokenAccrued(acc1);
      expect(borrowerAccruedExpected).to.closeTo(borrowerAccruedCurrent, parseUnits("0.000000000000000079", 18));

      // Repay
      const borrowBalanceStored = await vTOKEN1.borrowBalanceStored(acc1);
      await token1.connect(acc1Signer).faucet(borrowBalanceStored);
      await token1.connect(acc1Signer).approve(VTOKEN1, borrowBalanceStored);
      await expect(vTOKEN1.connect(acc1Signer).repayBorrow(borrowBalanceStored)).to.emit(vTOKEN1, "RepayBorrow");

      // Reward1 calculations for user 1
      borrowerAccruedExpected = await computeBorrowRewards(rewardDistributor1, VTOKEN1, vTOKEN1, acc1);
      borrowerAccruedCurrent = await rewardDistributor1.rewardTokenAccrued(acc1);
      expect(borrowerAccruedExpected).to.closeTo(borrowerAccruedCurrent, parseUnits("0.000000000000000006", 18));
    });
  });
}
