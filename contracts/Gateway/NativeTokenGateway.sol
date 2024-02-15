// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.20;

import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { SafeERC20, IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import { IWrappedNative } from "./Interfaces/IWrappedNative.sol";
import { INativeTokenGateway } from "./INativeTokenGateway.sol";
import { IVToken } from "./Interfaces/IVtoken.sol";

/**
 * @title NativeTokenGateway
 * @author Venus
 * @notice NativeTokenGateway contract facilitates interactions with a vToken market for native tokens (Native or wNativeToken)
 */
contract NativeTokenGateway is INativeTokenGateway, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /**
     * @notice Address of wrapped ether token contract
     */
    IWrappedNative public immutable wNativeToken;

    /**
     * @notice Address of wrapped native token market
     */
    IVToken public immutable vWNativeToken;

    /**
     * @notice Constructor for NativeTokenGateway
     * @param wrappedNativeToken Address of wrapped native token contract
     * @param vWrappedNativeToken Address of wrapped native token market
     */
    constructor(IWrappedNative wrappedNativeToken, IVToken vWrappedNativeToken) {
        ensureNonzeroAddress(address(wrappedNativeToken));
        ensureNonzeroAddress(address(vWrappedNativeToken));

        wNativeToken = wrappedNativeToken;
        vWNativeToken = vWrappedNativeToken;
    }

    /**
     * @notice To receive Native when msg.data is empty
     */
    receive() external payable {}

    /**
     * @notice To receive Native when msg.data is not empty
     */
    fallback() external payable {}

    /**
     * @notice Wrap Native, get wNativeToken, mint vWETH, and supply to the market.
     * @param minter The address on behalf of whom the supply is performed.
     * @custom:error ZeroAddressNotAllowed is thrown if address of minter is zero address
     * @custom:error ZeroValueNotAllowed is thrown if mintAmount is zero
     * @custom:event TokensWrappedAndSupplied is emitted when assets are supplied to the market
     */
    function wrapAndSupply(address minter) external payable nonReentrant {
        ensureNonzeroAddress(minter);

        uint256 mintAmount = msg.value;
        ensureNonzeroValue(mintAmount);

        wNativeToken.deposit{ value: mintAmount }();
        wNativeToken.approve(address(vWNativeToken), mintAmount);

        vWNativeToken.mintBehalf(minter, mintAmount);

        wNativeToken.approve(address(vWNativeToken), 0);
        emit TokensWrappedAndSupplied(minter, address(vWNativeToken), mintAmount);
    }

    /**
     * @notice Redeem vWETH, unwrap to ETH, and send to the user
     * @param redeemAmount The amount of underlying tokens to redeem
     * @custom:error ZeroValueNotAllowed is thrown if redeemAmount is zero
     * @custom:event TokensRedeemedAndUnwrapped is emitted when assets are redeemed from a market and unwrapped
     */
    function redeemUnderlyingAndUnwrap(uint256 redeemAmount) external nonReentrant {
        ensureNonzeroValue(redeemAmount);

        uint256 balanceBefore = wNativeToken.balanceOf(address(this));
        vWNativeToken.redeemUnderlyingBehalf(msg.sender, redeemAmount);
        uint256 balanceAfter = wNativeToken.balanceOf(address(this));

        uint256 nativeTokenBalanceBefore = address(this).balance;
        wNativeToken.withdraw(balanceAfter - balanceBefore);
        uint256 nativeTokenBalanceAfter = address(this).balance;

        uint256 redeemedAmount = nativeTokenBalanceAfter - nativeTokenBalanceBefore;

        _safeTransferETH(msg.sender, redeemedAmount);
        emit TokensRedeemedAndUnwrapped(msg.sender, address(vWNativeToken), redeemedAmount);
    }

    /**
     * @dev Borrow wNativeToken, unwrap to Native, and send to the user
     * @param borrowAmount The amount of underlying tokens to borrow
     * @custom:error ZeroValueNotAllowed is thrown if borrowAmount is zero
     * @custom:event TokensBorrowedAndUnwrapped is emitted when assets are borrowed from a market and unwrapped
     */
    function borrowAndUnwrap(uint256 borrowAmount) external nonReentrant {
        ensureNonzeroAddress(address(vWNativeToken));
        ensureNonzeroValue(borrowAmount);

        vWNativeToken.borrowBehalf(msg.sender, borrowAmount);

        wNativeToken.withdraw(borrowAmount);
        _safeTransferETH(msg.sender, borrowAmount);
        emit TokensBorrowedAndUnwrapped(msg.sender, address(vWNativeToken), borrowAmount);
    }

    /**
     * @notice Wrap Native, repay borrow in the market, and send remaining Native to the user
     * @custom:error ZeroValueNotAllowed is thrown if repayAmount is zero
     * @custom:event TokensWrappedAndRepaid is emitted when assets are repaid to a market and unwrapped
     */
    function wrapAndRepay() external payable nonReentrant {
        uint256 repayAmount = msg.value;
        ensureNonzeroValue(repayAmount);

        wNativeToken.deposit{ value: repayAmount }();
        wNativeToken.approve(address(vWNativeToken), repayAmount);

        uint256 borrowBalanceBefore = vWNativeToken.borrowBalanceCurrent(msg.sender);
        vWNativeToken.repayBorrowBehalf(msg.sender, repayAmount);
        uint256 borrowBalanceAfter = vWNativeToken.borrowBalanceCurrent(msg.sender);

        wNativeToken.approve(address(vWNativeToken), 0);

        if (borrowBalanceAfter == 0 && (repayAmount > borrowBalanceBefore)) {
            uint256 dust = repayAmount - borrowBalanceBefore;

            wNativeToken.withdraw(dust);
            _safeTransferETH(msg.sender, dust);
        }
        emit TokensWrappedAndRepaid(msg.sender, address(vWNativeToken), borrowBalanceBefore - borrowBalanceAfter);
    }

    /**
     * @notice Sweeps native assets (Native) from the contract and sends them to the owner
     * @custom:event SweepNative is emitted when assets are swept from the contract
     * @custom:access Controlled by Governance
     */
    function sweepNative() external onlyOwner {
        uint256 balance = address(this).balance;

        if (balance > 0) {
            _safeTransferETH((owner()), balance);
            emit SweepNative((owner()), balance);
        }
    }

    /**
     * @notice Sweeps wNativeToken tokens from the contract and sends them to the owner
     * @custom:event SweepToken emits on success
     * @custom:access Controlled by Governance
     */
    function sweepToken() external onlyOwner {
        uint256 balance = wNativeToken.balanceOf(address(this));

        if (balance > 0) {
            IERC20(address(wNativeToken)).safeTransfer(owner(), balance);
            emit SweepToken(owner(), balance);
        }
    }

    /**
     * @dev transfer Native to an address, revert if it fails
     * @param to recipient of the transfer
     * @param value the amount to send
     * @custom:error NativeTokenTransferFailed is thrown if the eth transfer fails
     */
    function _safeTransferETH(address to, uint256 value) internal {
        (bool success, ) = to.call{ value: value }(new bytes(0));

        if (!success) {
            revert NativeTokenTransferFailed();
        }
    }

    /**
     * @dev Checks if the provided address is nonzero, reverts otherwise
     * @param address_ Address to check
     * @custom:error ZeroAddressNotAllowed is thrown if the provided address is a zero address
     **/
    function ensureNonzeroAddress(address address_) internal pure {
        if (address_ == address(0)) {
            revert ZeroAddressNotAllowed();
        }
    }

    /**
     * @dev Checks if the provided value is nonzero, reverts otherwise
     * @param value_ Value to check
     * @custom:error ZeroValueNotAllowed is thrown if the provided value is 0
     */
    function ensureNonzeroValue(uint256 value_) internal pure {
        if (value_ == 0) {
            revert ZeroValueNotAllowed();
        }
    }
}
