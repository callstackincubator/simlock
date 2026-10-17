#import <Foundation/Foundation.h>
#import <xpc/xpc.h>

NS_ASSUME_NONNULL_BEGIN

/// The parts of AVConference's media-stream negotiator the iPhone source needs, plus the socket it
/// receives the stream on. All of it is reached through the Objective-C runtime rather than a
/// header, because Apple ships none for this framework.
///
/// It is a separate target because SwiftPM refuses a target that mixes Swift and Objective-C
/// sources. Only `simlock-device-capture` links it.

/// Installs this process's own HEVC capability overrides (see the .m) and builds the negotiator in
/// `mode` (5 is the media-stream mode) from `options`. nil when AVConference cannot be loaded.
NSObject * _Nullable simlockNegotiator(NSDictionary *options, NSInteger mode);

/// The negotiator's offer, the SDP-shaped blob `startMediaStream` is asked to send.
NSData * _Nullable simlockOffer(NSObject *negotiator);

/// Applies the iPhone's answer and returns the resulting media-stream configuration, or nil when
/// the answer was refused.
NSDictionary * _Nullable simlockAnswer(NSObject *negotiator, NSData *answer);

/// Binds a UDP socket on the host's own address on the route to the iPhone's tunnel, and returns
/// that address. The bound socket becomes the receiver `simlockAdoptedSocket` later reports.
NSString * _Nullable simlockBindForTunnel(NSString *tunnelIPAddress);

/// The port `simlockBindForTunnel` landed on, 0 when there is no receiver.
uint16_t simlockReceiverPort(void);

/// One datagram from the receiver, or nil when none arrived within `milliseconds`.
NSData * _Nullable simlockReceive(int milliseconds);

/// Sends one RTCP packet on the receiver.
BOOL simlockSend(NSData *packet);

/// Takes the socket CoreDevice hands back for this stream when the process has not bound one yet.
void simlockAdopt(xpc_object_t sockets);

/// Closes the receiver, which is what unblocks a `simlockReceive` that is waiting.
void simlockCloseReceiver(void);

NS_ASSUME_NONNULL_END
